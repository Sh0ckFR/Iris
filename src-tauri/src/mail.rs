//! E-mail, read only: the unread messages of the inbox (who, what, when) for Iris's proactive
//! suggestions and the check_email / read_email tools. A minimal IMAP client over TLS (port 993):
//! it logs in, opens the inbox *read-only* (EXAMINE: nothing is marked as read) and fetches
//! headers, or one message's raw text (decoded in the web app, lib/mail.ts).
//!
//! Works with any IMAP account that accepts a password: Gmail and iCloud with an app password,
//! Fastmail, OVH, Infomaniak, Orange… Outlook.com / Microsoft 365 require OAuth and refuse it.

use std::{sync::Arc, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_rustls::{client::TlsStream, TlsConnector};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The account, from the vault (Settings → Proactivity → E-mail).
#[derive(Deserialize)]
pub struct MailAccount {
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    user: String,
    password: String,
}

fn default_port() -> u16 {
    993
}

/// One unread message's headers, as the server sends them (decoded by the web app).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailHeader {
    uid: u32,
    /// Raw `From:`, `Subject:`, `Date:` header lines (RFC 2047 words still encoded).
    headers: String,
}

/// A message's raw source (headers and body), cut at `MAX_MESSAGE_BYTES`, in base64: its parts
/// may be in any charset, decoded by the web app.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailMessage {
    uid: u32,
    raw_base64: String,
}

const TIMEOUT: Duration = Duration::from_secs(20);
/// The newest unread messages only: a full inbox must not flood Iris.
const MAX_UNREAD: usize = 25;
const MAX_MESSAGE_BYTES: usize = 200_000;

struct Imap {
    stream: BufReader<TlsStream<TcpStream>>,
    tag: u32,
}

/// One server answer: its text lines and the literals (`{n}` blocks) they announced.
#[derive(Default)]
struct Answer {
    lines: Vec<String>,
    literals: Vec<Vec<u8>>,
    /// For each literal, the line that announced it, and the line right after it (some servers
    /// give the UID there: `* 1 FETCH (BODY[…] {120}` … ` UID 345)`).
    literal_lines: Vec<String>,
    literal_after: Vec<String>,
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

impl Imap {
    async fn connect(account: &MailAccount) -> CmdResult<Self> {
        let host = account.host.trim().to_string();
        if host.is_empty() || host.contains(['/', ' ']) {
            return Err("invalid mail server name".into());
        }
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .map_err(err)?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let name = rustls::pki_types::ServerName::try_from(host.clone()).map_err(err)?;
        let tcp = tokio::time::timeout(TIMEOUT, TcpStream::connect((host.as_str(), account.port)))
            .await
            .map_err(|_| format!("{host} did not answer"))?
            .map_err(|e| format!("could not reach {host}: {e}"))?;
        let tls = tokio::time::timeout(TIMEOUT, TlsConnector::from(Arc::new(config)).connect(name, tcp))
            .await
            .map_err(|_| "the secure connection timed out".to_string())?
            .map_err(|e| format!("secure connection refused: {e}"))?;
        let mut imap = Imap { stream: BufReader::new(tls), tag: 0 };
        // Greeting: "* OK …"
        let mut greeting = String::new();
        imap.read_line(&mut greeting).await?;
        if !greeting.starts_with("* OK") && !greeting.starts_with("* PREAUTH") {
            return Err(format!("unexpected greeting from {host}"));
        }
        let login = format!("LOGIN {} {}", quote(&account.user), quote(&account.password));
        imap.command(&login).await.map_err(|e| {
            if e.contains("NO") || e.contains("BAD") {
                "the mail server refused the login (for Gmail or iCloud, use an app password)".to_string()
            } else {
                e
            }
        })?;
        Ok(imap)
    }

    async fn read_line(&mut self, line: &mut String) -> CmdResult<()> {
        line.clear();
        let mut bytes = Vec::new();
        let n = tokio::time::timeout(TIMEOUT, self.stream.read_until(b'\n', &mut bytes))
            .await
            .map_err(|_| "the mail server stopped answering".to_string())?
            .map_err(err)?;
        if n == 0 {
            return Err("the mail server closed the connection".into());
        }
        *line = String::from_utf8_lossy(&bytes).into_owned();
        Ok(())
    }

    /// Sends a command and reads everything up to its tagged completion.
    async fn command(&mut self, command: &str) -> CmdResult<Answer> {
        self.tag += 1;
        let tag = format!("a{}", self.tag);
        let line = format!("{tag} {command}\r\n");
        self.stream.get_mut().write_all(line.as_bytes()).await.map_err(err)?;
        let mut answer = Answer::default();
        let mut text = String::new();
        loop {
            self.read_line(&mut text).await?;
            let trimmed = text.trim_end().to_string();
            if answer.literal_after.len() < answer.literals.len() {
                answer.literal_after.push(trimmed.clone());
            }
            // A literal follows: "{123}" at the end of the line, then exactly 123 bytes.
            if let Some(size) = trimmed.strip_suffix('}').and_then(|s| s.rsplit_once('{')).and_then(|(_, n)| n.parse::<usize>().ok()) {
                let mut data = vec![0u8; size];
                tokio::time::timeout(TIMEOUT, self.stream.read_exact(&mut data))
                    .await
                    .map_err(|_| "the mail server stopped answering".to_string())?
                    .map_err(err)?;
                answer.literal_lines.push(trimmed.clone());
                answer.literals.push(data);
                answer.lines.push(trimmed);
                continue;
            }
            if let Some(status) = trimmed.strip_prefix(&format!("{tag} ")) {
                return if status.starts_with("OK") {
                    Ok(answer)
                } else {
                    Err(format!("mail server: {status}"))
                };
            }
            answer.lines.push(trimmed);
        }
    }

    async fn logout(mut self) {
        let _ = self.command("LOGOUT").await;
    }
}

/// UIDs from "* SEARCH 4 8 15".
fn parse_search(answer: &Answer) -> Vec<u32> {
    answer
        .lines
        .iter()
        .filter_map(|l| l.strip_prefix("* SEARCH"))
        .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()))
        .collect()
}

/// The UID in a FETCH line ("* 12 FETCH (UID 345 BODY[…] {120}").
fn uid_of(line: &str) -> Option<u32> {
    let upper = line.to_ascii_uppercase();
    let at = upper.find("UID ")?;
    line[at + 4..].split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// The newest unread messages of the inbox (newest first): their From, Subject and Date lines.
#[tauri::command]
pub async fn mail_unread(account: MailAccount) -> CmdResult<Vec<MailHeader>> {
    let mut imap = Imap::connect(&account).await?;
    let result = async {
        imap.command("EXAMINE INBOX").await?;
        let mut uids = parse_search(&imap.command("UID SEARCH UNSEEN").await?);
        uids.sort_unstable();
        let newest: Vec<String> = uids.iter().rev().take(MAX_UNREAD).map(|u| u.to_string()).collect();
        if newest.is_empty() {
            return Ok(Vec::new());
        }
        let answer = imap
            .command(&format!("UID FETCH {} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])", newest.join(",")))
            .await?;
        let mut headers: Vec<MailHeader> = answer
            .literal_lines
            .iter()
            .zip(&answer.literals)
            .enumerate()
            .filter_map(|(i, (line, data))| {
                let uid = uid_of(line).or_else(|| answer.literal_after.get(i).and_then(|after| uid_of(after)))?;
                Some(MailHeader { uid, headers: String::from_utf8_lossy(data).into_owned() })
            })
            .collect();
        headers.sort_by(|a, b| b.uid.cmp(&a.uid));
        Ok(headers)
    }
    .await;
    imap.logout().await;
    result
}

/// One message's source (for read_email), without marking it as read.
#[tauri::command]
pub async fn mail_read(account: MailAccount, uid: u32) -> CmdResult<MailMessage> {
    let mut imap = Imap::connect(&account).await?;
    let result = async {
        imap.command("EXAMINE INBOX").await?;
        let answer = imap.command(&format!("UID FETCH {uid} (UID BODY.PEEK[]<0.{MAX_MESSAGE_BYTES}>)")).await?;
        let raw = answer.literals.first().ok_or("this message no longer exists")?;
        use base64::Engine;
        Ok(MailMessage { uid, raw_base64: base64::engine::general_purpose::STANDARD.encode(raw) })
    }
    .await;
    imap.logout().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_search_and_fetch_lines() {
        let answer = Answer { lines: vec!["* SEARCH 4 8 15".into(), "* OK done".into()], ..Default::default() };
        assert_eq!(parse_search(&answer), [4, 8, 15]);
        assert_eq!(uid_of("* 12 FETCH (UID 345 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {120}"), Some(345));
        assert_eq!(uid_of("* 3 FETCH (FLAGS (\\Seen))"), None);
        assert_eq!(quote(r#"pa"ss\word"#), r#""pa\"ss\\word""#);
    }
}
