//! Requests made for the model (`web_get`, `skill_http`) reach the public internet only.
//!
//! A page Iris reads, or a skill she wrote after reading one, could otherwise point her at
//! `http://localhost:…`, the router's admin page or a cloud metadata address (SSRF). Every
//! address is checked where it is actually used: host names through a resolver that drops
//! private addresses (so a public name can't resolve — or be re-resolved — to a private one),
//! literal IP addresses in the URL and in each redirect.

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use reqwest::{
    dns::{Addrs, Name, Resolve, Resolving},
    redirect, Url,
};

/// An address on the public internet: not loopback, private, link-local, carrier-grade NAT,
/// multicast, documentation or otherwise reserved.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_v4(v4);
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (first & 0xffc0) == 0xfec0 // site-local fec0::/10 (deprecated)
                || first == 0x2001 && v6.segments()[1] == 0x0db8 // documentation
                || first == 0x0064 && v6.segments()[1] == 0xff9b) // NAT64 of IPv4 addresses
        }
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local() // 169.254/16, cloud metadata included
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0 // "this network"
        || (a == 100 && (64..128).contains(&b)) // carrier-grade NAT 100.64/10
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved
}

/// Rejects anything but a public http(s) URL whose host is not a private address literal.
pub fn check_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid URL: {e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("only http(s) addresses can be reached".into());
    }
    check_host(&url)?;
    Ok(url)
}

fn check_host(url: &Url) -> Result<(), String> {
    let blocked = || {
        format!(
            "{} is on this computer or the local network: Iris only reaches public internet addresses",
            url.host_str().unwrap_or("this address")
        )
    };
    match url.host() {
        Some(url::Host::Ipv4(ip)) if !is_public(IpAddr::V4(ip)) => Err(blocked()),
        Some(url::Host::Ipv6(ip)) if !is_public(IpAddr::V6(ip)) => Err(blocked()),
        Some(url::Host::Domain(name)) if name.eq_ignore_ascii_case("localhost") || name.to_ascii_lowercase().ends_with(".localhost") => Err(blocked()),
        None => Err("this address has no host".into()),
        _ => Ok(()),
    }
}

/// System DNS, keeping only public addresses.
struct PublicResolver;

impl Resolve for PublicResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let host = name.as_str().to_string();
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let public: Vec<SocketAddr> = addrs.into_iter().filter(|a| is_public(a.ip())).collect();
            if public.is_empty() {
                return Err(format!("{host} points to this computer or the local network: Iris only reaches public internet addresses").into());
            }
            Ok(Box::new(public.into_iter()) as Addrs)
        })
    }
}

/// An HTTP client that can only reach public addresses, redirects included.
pub fn client(user_agent: &str, timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(user_agent)
        .timeout(timeout)
        .dns_resolver(Arc::new(PublicResolver))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if let Err(reason) = check_host(attempt.url()) {
                attempt.error(reason)
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

/// A request error with its causes ("error sending request" alone hides why, e.g. a refused
/// private address).
pub fn describe(error: reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_reserved_addresses_are_refused() {
        for ip in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "255.255.255.255", "224.0.0.1",
            "::1", "::", "fd00::1", "fe80::1", "::ffff:192.168.1.1", "64:ff9b::a00:1",
        ] {
            assert!(!is_public(ip.parse().unwrap()), "{ip} should be refused");
        }
        for ip in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn urls_are_checked() {
        assert!(check_url("https://example.com/page").is_ok());
        assert!(check_url("http://localhost:8080/").is_err());
        assert!(check_url("http://app.localhost/").is_err());
        assert!(check_url("http://127.0.0.1/").is_err());
        assert!(check_url("http://[::1]:3000/").is_err());
        assert!(check_url("http://192.168.0.1/admin").is_err());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("ftp://example.com/").is_err());
    }

    #[test]
    fn names_resolving_to_private_addresses_are_refused() {
        let name: Name = "localhost".parse().unwrap();
        let result = tauri::async_runtime::block_on(PublicResolver.resolve(name));
        assert!(result.is_err());
    }
}
