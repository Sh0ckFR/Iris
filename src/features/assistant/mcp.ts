import { useSyncExternalStore } from 'react';
import { createMCPClient, type MCPClient, type MCPTransport } from '@ai-sdk/mcp';
import type { Tool, ToolSet } from 'ai';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * External services through MCP (Model Context Protocol): email, calendars, smart home, code
 * hosting, notes… Each server's tools become Iris's tools (`mcp_<server>_<tool>`).
 *
 * Configuration (Settings, kept in the encrypted vault since it often holds tokens), in the
 * usual `mcpServers` format:
 *   { "mcpServers": {
 *       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/me/Documents"] },
 *       "home":  { "url": "http://homeassistant.local:8123/api/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
 * Command servers are started by Rust (src-tauri/src/mcp.rs) and spoken to over stdin/stdout;
 * URL servers go through the standard `mcp-remote` adapter the same way (needs Node.js), which
 * also avoids the webview's network restrictions.
 */

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface McpStatus {
  name: string;
  state: 'connecting' | 'connected' | 'error' | 'disabled';
  tools: number;
  error?: string;
}

/** One MCP tool, ready to be offered to the model. */
export interface McpTool {
  name: string;
  server: string;
  tool: Tool;
  /** The server says the tool only reads (no approval needed). Untrusted hint, like the others. */
  readOnly: boolean;
  destructive: boolean;
}

/** `{ "mcpServers": {…} }` or directly `{ "name": {…} }`. */
export function parseMcpConfig(raw: string | undefined): { servers: Record<string, McpServerConfig>; error?: string } {
  if (!raw?.trim()) return { servers: {} };
  try {
    const data = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> } & Record<string, McpServerConfig>;
    const servers = (data.mcpServers ?? data) as Record<string, McpServerConfig>;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== 'object' || (!cfg.command && !cfg.url)) return { servers: {}, error: `"${name}": a "command" or a "url" is needed.` };
    }
    return { servers };
  } catch (error) {
    return { servers: {}, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** MCP over the Rust process bridge: one JSON-RPC message per line. */
class TauriStdioTransport implements MCPTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: MCPTransport['onmessage'];
  private unlisten: UnlistenFn[] = [];
  private closed = false;

  constructor(
    private readonly id: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly env: Record<string, string>,
  ) {}

  async start() {
    this.unlisten.push(
      await listen<string>(`mcp://message/${this.id}`, (e) => {
        try {
          this.onmessage?.(JSON.parse(e.payload));
        } catch {
          // Some servers print logs on stdout: not protocol messages.
          console.warn(`[iris:mcp] ${this.id}: ${e.payload.slice(0, 200)}`);
        }
      }),
      await listen(`mcp://closed/${this.id}`, () => {
        if (!this.closed) this.onerror?.(new Error('the server stopped'));
        this.finish();
      }),
    );
    await invoke('mcp_start', { id: this.id, command: this.command, args: this.args, env: this.env });
  }

  async send(message: Parameters<MCPTransport['send']>[0]) {
    await invoke('mcp_send', { id: this.id, message: JSON.stringify(message) });
  }

  async close() {
    this.closed = true;
    await invoke('mcp_stop', { id: this.id }).catch(() => {});
    this.finish();
  }

  private finish() {
    this.unlisten.splice(0).forEach((u) => u());
    this.onclose?.();
  }
}

// ---------------------------------------------------------------- connections

let clients: MCPClient[] = [];
let tools: McpTool[] = [];
let statuses: McpStatus[] = [];
let appliedConfig: string | undefined;
let generation = 0;
const listeners = new Set<() => void>();

function setStatus(name: string, patch: Partial<McpStatus>) {
  statuses = statuses.map((s) => (s.name === name ? { ...s, ...patch } : s));
  listeners.forEach((l) => l());
}

/** First start of an `npx` server downloads it: give it time. */
const START_TIMEOUT_MS = 120_000;

async function connect(name: string, cfg: McpServerConfig, gen: number) {
  const id = safe(name).slice(0, 40);
  const headers = Object.entries(cfg.headers ?? {}).flatMap(([k, v]) => ['--header', `${k}: ${v}`]);
  const [command, args] = cfg.url ? ['npx', ['-y', 'mcp-remote', cfg.url, ...headers]] : [cfg.command!, cfg.args ?? []];
  try {
    const client = await createMCPClient({
      transport: new TauriStdioTransport(id, command, args, cfg.env ?? {}),
      initializationOptions: { timeout: START_TIMEOUT_MS },
      onUncaughtError: (error) => console.warn(`[iris:mcp] ${name}`, error),
    });
    if (gen !== generation) return void client.close(); // configuration changed meanwhile
    const definitions = await client.listTools({ options: { timeout: 30_000 } });
    const set = client.toolsFromDefinitions(definitions) as Record<string, Tool>;
    const found: McpTool[] = definitions.tools.map((d) => ({
      name: `mcp_${id}_${safe(d.name)}`.slice(0, 64),
      server: name,
      tool: set[d.name],
      readOnly: d.annotations?.readOnlyHint === true,
      destructive: d.annotations?.destructiveHint === true,
    }));
    clients.push(client);
    tools = [...tools, ...found.filter((t) => t.tool)];
    setStatus(name, { state: 'connected', tools: found.length });
    console.warn(`[iris:mcp] ${name}: ${found.length} tools`);
  } catch (error) {
    if (gen !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    setStatus(name, { state: 'error', error: message });
    console.warn(`[iris:mcp] ${name} failed: ${message}`);
    await invoke('mcp_stop', { id }).catch(() => {});
  }
}

/** (Re)connects the configured servers when the configuration changed. */
export async function configureMcp(raw: string | undefined) {
  if (raw === appliedConfig) return;
  appliedConfig = raw;
  const gen = ++generation;
  const old = clients;
  clients = [];
  tools = [];
  await Promise.all(old.map((c) => c.close().catch(() => {})));
  const { servers, error } = parseMcpConfig(raw);
  if (error) console.warn(`[iris:mcp] ${error}`);
  statuses = Object.entries(servers).map(([name, cfg]) => ({ name, state: cfg.disabled ? 'disabled' : 'connecting', tools: 0 }));
  listeners.forEach((l) => l());
  await Promise.all(Object.entries(servers).filter(([, cfg]) => !cfg.disabled).map(([name, cfg]) => connect(name, cfg, gen)));
}

/** The tools of the connected servers (read at each request: servers may connect later). */
export const mcpTools = (): McpTool[] => tools;

/** A tool result for the model: MCP servers can return very long texts. */
export function clipMcpResult(result: unknown, max = 8000): unknown {
  const r = result as { content?: { type: string; text?: string }[] };
  if (!Array.isArray(r?.content)) return result;
  let budget = max;
  return {
    ...r,
    content: r.content.map((part) => {
      if (part.type !== 'text' || typeof part.text !== 'string') return part;
      const text = part.text.length > budget ? `${part.text.slice(0, budget)}\n… (truncated)` : part.text;
      budget = Math.max(0, budget - text.length);
      return { ...part, text };
    }),
  };
}

export function useMcpStatus(): McpStatus[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => statuses,
  );
}

export type { ToolSet };
