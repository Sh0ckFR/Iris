// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decryptDoc, encryptDoc, parseSyncConfig, WrongPassphrase } from './sync';
import { emptyDoc } from './syncMerge';

describe('memory sync', () => {
  it('encrypts end to end: only the passphrase opens it', async () => {
    const doc = { ...emptyDoc(), facts: [{ id: 'f-1', text: 'Julie se marie le 12 juin.', createdAt: 1, source: 'user' as const }] };
    const sealed = await encryptDoc(doc, 'correct horse battery');
    expect(sealed).not.toContain('Julie');
    expect((await decryptDoc(sealed, 'correct horse battery')).facts[0].text).toBe('Julie se marie le 12 juin.');
    await expect(decryptDoc(sealed, 'wrong passphrase!')).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it('reads the saved configuration', () => {
    expect(parseSyncConfig('{"kind":"gist","token":"ghp_x","passphrase":"12345678"}')).toEqual({ kind: 'gist', token: 'ghp_x', passphrase: '12345678' });
    expect(parseSyncConfig('{"kind":"webdav","url":"https://dav.example/iris.sync","user":"me","password":"p","passphrase":"12345678"}')?.kind).toBe('webdav');
    // A passphrase too short to protect anything: no sync.
    expect(parseSyncConfig('{"kind":"gist","token":"ghp_x","passphrase":"123"}')).toBeNull();
    expect(parseSyncConfig(undefined)).toBeNull();
  });
});
