import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Client, Stronghold } from '@tauri-apps/plugin-stronghold';

/**
 * API keys live in a Stronghold vault (encrypted at rest). Its master password is generated
 * by Rust and kept in the OS credential store — see src-tauri/src/vault.rs.
 */
/** `mcp`: the MCP servers configuration (JSON), kept here because it often holds tokens. */
export type SecretKey = 'openai' | 'anthropic' | 'google' | 'tavily' | 'mcp';
export type Secrets = Partial<Record<SecretKey, string>>;

export const SECRET_KEYS: SecretKey[] = ['openai', 'anthropic', 'google', 'tavily', 'mcp'];

const CLIENT_NAME = 'iris';

interface Vault {
  stronghold: Stronghold;
  client: Client;
}

let vaultPromise: Promise<Vault> | null = null;

/** Opens the vault once per session (concurrent callers share the same promise). */
function openVault(): Promise<Vault> {
  if (!vaultPromise) {
    vaultPromise = (async () => {
      const { path, password } = await invoke<{ path: string; password: string }>('vault_params');
      const stronghold = await Stronghold.load(path, password);
      let client: Client;
      try {
        client = await stronghold.loadClient(CLIENT_NAME);
      } catch {
        client = await stronghold.createClient(CLIENT_NAME);
      }
      return { stronghold, client };
    })();
    // A failed open must not poison every later attempt.
    vaultPromise.catch(() => {
      vaultPromise = null;
    });
  }
  return vaultPromise;
}

export async function loadSecrets(): Promise<Secrets> {
  const { client } = await openVault();
  const store = client.getStore();
  const decoder = new TextDecoder();
  const entries = await Promise.all(
    SECRET_KEYS.map(async (key) => {
      const data = await store.get(key).catch(() => null);
      return [key, data && data.length ? decoder.decode(new Uint8Array(data)) : undefined] as const;
    }),
  );
  return Object.fromEntries(entries.filter(([, v]) => v)) as Secrets;
}

/** `null` or an empty string deletes the key. */
export async function saveSecrets(patch: Partial<Record<SecretKey, string | null>>): Promise<void> {
  const { stronghold, client } = await openVault();
  const store = client.getStore();
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(patch)) {
    if (value) await store.insert(key, Array.from(encoder.encode(value)));
    else await store.remove(key).catch(() => null);
  }
  await stronghold.save(); // flush the encrypted snapshot to disk
}

export function useSecrets() {
  const [secrets, setSecrets] = useState<Secrets>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadSecrets()
      .then((s) => {
        if (!alive) return;
        setSecrets(s);
        setStatus('ready');
      })
      .catch((e) => {
        if (!alive) return;
        setError(`Could not open the key vault: ${String(e)}`);
        setStatus('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Keys take effect immediately (in memory); the promise settles when the encrypted vault
   * has been written. Vault writes are deliberately slow (scrypt), so callers shouldn't block on it.
   */
  const save = useCallback(async (patch: Partial<Record<SecretKey, string | null>>) => {
    setSecrets((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(patch) as [SecretKey, string | null][]) {
        if (value) next[key] = value;
        else delete next[key];
      }
      return next;
    });
    const started = performance.now();
    await saveSecrets(patch);
    console.info(`[iris] vault saved in ${Math.round(performance.now() - started)} ms`);
  }, []);

  return { secrets, status, error, save };
}
