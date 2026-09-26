import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Phase } from '../assistant/useAssistant';
import type { LocalWakeStatus } from '../assistant/localWake';
import type { VoiceMode } from '../../lib/settings';
import { useUsage } from '../../lib/usage';
import { formatMoneyBoth, useCosts } from '../../lib/costs';
import { useMcpStatus } from '../assistant/mcp';
import { uiLocale, useT } from '../../i18n';

interface Stats {
  cpu: number;
  memoryUsed: number;
  memoryTotal: number;
  uptimeSecs: number;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      invoke<Stats>('system_stats')
        .then((s) => alive && setStats(s))
        .catch(() => {});
    void poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return stats;
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="tele-meter">
      <div className="tele-meter-head">
        <span>{label}</span>
        <span>{detail}</span>
      </div>
      <div className="tele-bar">
        <div className={`tele-bar-fill${pct > 85 ? ' tele-bar-fill--hot' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** HUD readouts: clock, system load, subsystem status. */
export function Telemetry({
  phase,
  brain,
  voiceReady,
  voiceActive,
  webSearch,
  wake,
  voiceMode,
}: {
  phase: Phase;
  brain: string | null;
  voiceReady: boolean;
  voiceActive: boolean;
  webSearch: boolean;
  /** Always-on listening (local "Iris" detection). */
  wake: { status: LocalWakeStatus; detail?: string };
  voiceMode: VoiceMode;
}) {
  const now = useClock();
  const stats = useStats();
  const usage = useUsage();
  const mcp = useMcpStatus();
  const t = useT();
  const tt = t.telemetry;
  const locale = uiLocale();
  const gb = (b: number) => (b / 1024 ** 3).toFixed(1);
  // Since Iris started (the Rust side counts from its own launch).
  const uptime = !stats
    ? '—'
    : stats.uptimeSecs < 3600
      ? `${Math.floor(stats.uptimeSecs / 60)} min`: `${Math.floor(stats.uptimeSecs / 3600)} h ${Math.floor((stats.uptimeSecs % 3600) / 60)} min`;
  const costs = useCosts();
  // Euros, with the US dollars the providers bill in brackets.
  const money = (usd: number) => formatMoneyBoth(usd, costs.eurPerUsd);
  const saved = costs.today ? costs.today.savedCacheUsd + costs.today.savedToolsUsd : 0;
  /** 12345 → "12,3 k" */
  const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} k`);
  const cachedShare = usage.inputTokens ? Math.round((usage.cachedInputTokens / usage.inputTokens) * 100) : 0;

  const wakeState: Record<LocalWakeStatus, string> = {
    off: tt.wake.off,
    loading: tt.wake.loading(wake.detail ?? ''),
    listening: tt.wake.listening,
    paused: tt.wake.paused,
    error: tt.wake.error,
  };
  /** [name, online, state label override] */
  const systems: [string, boolean, string?][] = [
    [tt.systems.neuralCore, !!brain],
    [tt.systems.voiceMode, voiceReady, voiceMode === 'economy' ? tt.systems.economy : tt.systems.premium],
    [tt.systems.localListening, wake.status === 'listening' || wake.status === 'paused', wakeState[wake.status].trim()],
    ...(voiceMode === 'realtime' ? [[tt.systems.realtimeSession, voiceActive] as [string, boolean]] : []),
    ...(mcp.length
      ? [
          [
            tt.systems.mcp,
            mcp.some((s) => s.state === 'connected'),
            `${mcp.filter((s) => s.state === 'connected').length}/${mcp.filter((s) => s.state !== 'disabled').length}`,
          ] as [string, boolean, string],
        ]
      : []),
    [tt.systems.webSearch, true],
    [tt.systems.webAnswers, webSearch],
  ];
  /** The local listening row (its tooltip shows the error). */
  const wakeRow = 2;

  return (
    <aside className="tele" aria-label={tt.label}>
      <div className="tele-clock">
        <span className="tele-time">{now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        <span className="tele-date">{now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
      </div>

      <div className="tele-phase">
        <span className={`tele-dot tele-dot--${phase}`} />
        {tt.phase[phase]}
      </div>

      {stats && (
        <div className="tele-block">
          <Meter label="CPU" value={stats.cpu} detail={`${Math.round(stats.cpu)} %`} />
          <Meter
            label={tt.memory}
            value={(stats.memoryUsed / stats.memoryTotal) * 100}
            detail={`${gb(stats.memoryUsed)} / ${gb(stats.memoryTotal)} ${tt.gigabytes}`}
          />
          <div className="tele-row">
            <span>{tt.uptime}</span>
            <span>{uptime}</span>
          </div>
        </div>
      )}

      {/* Consumption since launch: where tokens go, and what caching / local answers save. */}
      <div className="tele-block">
        <div className="tele-row">
          <span>{tt.requests}</span>
          <span>
            {usage.requests + usage.realtimeResponses} / {usage.localAnswers}
          </span>
        </div>
        <div className="tele-row">
          <span>{tt.inputTokens}</span>
          <span>
            {tokens(usage.inputTokens)}
            {usage.inputTokens > 0 && ` · ${cachedShare} % ${tt.cached}`}
          </span>
        </div>
        <div className="tele-row">
          <span>{tt.outputTokens}</span>
          <span>{tokens(usage.outputTokens)}</span>
        </div>
        {usage.audioInputTokens + usage.audioOutputTokens > 0 && (
          <div className="tele-row">
            <span>{tt.realtimeAudio}</span>
            <span>
              {tokens(usage.audioInputTokens)} / {tokens(usage.audioOutputTokens)}
            </span>
          </div>
        )}
        <div
          className="tele-row"
          title={
            costs.today
              ? Object.entries(costs.today.byModel)
                  .map(([model, usd]) => `${model}: ${money(usd)}`)
                  .join('\n')
              : undefined
          }
        >
          <span>{tt.costToday}</span>
          <span>{money(costs.today?.usd ?? 0)}</span>
        </div>
        <div className="tele-row">
          <span>{tt.costMonth}</span>
          <span>{money(costs.monthUsd)}</span>
        </div>
        {saved > 0 && (
          <div className="tele-row" title={tt.savedTitle}>
            <span>{tt.savedToday}</span>
            <span>{money(saved)}</span>
          </div>
        )}
        {usage.ttsCharacters > 0 && (
          <div className="tele-row">
            <span>{tt.voiceChars}</span>
            <span>
              {tokens(usage.ttsCharacters)} {tt.chars}
            </span>
          </div>
        )}
      </div>

      <ul className="tele-systems">
        {systems.map(([name, ok, state], i) => (
          <li key={name} className={ok ? 'ok' : 'off'} title={i === wakeRow && wake.status === 'error' ? wake.detail : undefined}>
            <span className="tele-sys-dot" />
            {name}
            <span className="tele-sys-state">{state ?? (ok ? tt.online : tt.offline)}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
