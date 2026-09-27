import { describe, expect, it } from 'vitest';
import { decodeWords, htmlToText, mimeText, parseAddress, parseHeaders, parseMailAccount } from './mail';

describe('e-mail decoding', () => {
  it('decodes encoded words (base64, quoted-printable, other charsets)', () => {
    expect(decodeWords('=?UTF-8?B?Q2zDqW1lbnQ=?= Martin')).toBe('Clément Martin');
    expect(decodeWords('=?ISO-8859-1?Q?R=E9union_demain?=')).toBe('Réunion demain');
    // Adjacent encoded words are joined without the space between them.
    expect(decodeWords('=?UTF-8?Q?Bonne_?= =?UTF-8?Q?ann=C3=A9e?=')).toBe('Bonne année');
  });

  it('reads folded headers and addresses', () => {
    const h = parseHeaders('From: "Claire M." <claire@example.fr>\r\nSubject: Devis\r\n pour lundi\r\nDate: Mon, 28 Sep 2026 09:12:00 +0200');
    expect(h.subject).toBe('Devis pour lundi');
    expect(parseAddress(h.from)).toEqual({ name: 'Claire M.', address: 'claire@example.fr' });
    expect(parseAddress('bob@example.com')).toEqual({ name: 'bob@example.com', address: 'bob@example.com' });
  });

  it('finds the plain text of a multipart message, in its charset', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=ISO-8859-1',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Bonjour, voici le devis de l=E9t=E9.',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Bonjour</p>',
      '--b1--',
    ].join('\r\n');
    expect(mimeText(raw).plain?.trim()).toBe('Bonjour, voici le devis de lété.');
    expect(mimeText(raw).html).toContain('Bonjour');
  });

  it('makes HTML readable', () => {
    expect(htmlToText('<style>p{}</style><p>Salut&nbsp;!</p><p>A&amp;B &#233;t&#233;</p>')).toBe('Salut !\nA&B été');
  });

  it('reads the saved account', () => {
    expect(parseMailAccount('{"host":"imap.gmail.com","user":"me@gmail.com","password":"x"}')).toEqual({ host: 'imap.gmail.com', port: 993, user: 'me@gmail.com', password: 'x' });
    expect(parseMailAccount('{"host":"imap.gmail.com"}')).toBeNull();
    expect(parseMailAccount(undefined)).toBeNull();
  });
});
