/**
 * Synthesized interface chirps (no audio files): short sine/triangle blips shaped with gain
 * envelopes, in the spirit of sci-fi HUD sounds.
 */

export type Sfx = 'boot' | 'listen' | 'stop' | 'alert' | 'approve' | 'decline';

let ctx: AudioContext | null = null;
let enabled = true;

export function setSfxEnabled(value: boolean) {
  enabled = value;
}

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** One enveloped tone gliding from `from` to `to` Hz. */
function tone(start: number, duration: number, from: number, to: number, volume = 0.08, type: OscillatorType = 'sine') {
  const c = audio();
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export function playSfx(sound: Sfx) {
  if (!enabled) return;
  try {
    switch (sound) {
      case 'boot':
        tone(0, 0.5, 180, 720, 0.05, 'triangle');
        tone(0.35, 0.18, 880, 880, 0.05);
        tone(0.5, 0.25, 1320, 1320, 0.04);
        break;
      case 'listen':
        tone(0, 0.09, 660, 990, 0.07);
        tone(0.08, 0.1, 1320, 1320, 0.05);
        break;
      case 'stop':
        tone(0, 0.12, 990, 520, 0.06);
        break;
      case 'alert':
        tone(0, 0.12, 1180, 1180, 0.06, 'triangle');
        tone(0.16, 0.12, 1180, 1180, 0.06, 'triangle');
        break;
      case 'approve':
        tone(0, 0.08, 880, 880, 0.06);
        tone(0.07, 0.14, 1320, 1760, 0.05);
        break;
      case 'decline':
        tone(0, 0.18, 440, 300, 0.06, 'triangle');
        break;
    }
  } catch {
    // Audio unavailable: sounds are cosmetic.
  }
}

// ---------------------------------------------------------------- per-tool sounds

type ToolSfx = 'news' | 'weather' | 'markets' | 'search' | 'read' | 'wiki' | 'system' | 'computer' | 'screen' | 'create' | 'memory' | 'timer' | 'hud' | 'link';

/** Which sound a tool makes when it starts (first matching rule; MCP and unknown tools: "link"). */
const TOOL_SOUNDS: [RegExp, ToolSfx][] = [
  [/^get_news$/, 'news'],
  [/^get_weather$/, 'weather'],
  [/^get_stock_quote$/, 'markets'],
  [/^search_web$/, 'search'],
  [/^(read_webpage|reread_document|check_email|read_email)$/, 'read'],
  [/^lookup_wikipedia$/, 'wiki'],
  [/^look_at_screen$/, 'screen'],
  [/^(use_computer|manage_window|list_windows)$/, 'computer'],
  [/^(create_visual|generate_image|create_skill|show_data)$/, 'create'],
  [/^(remember|forget|recall_memory)$/, 'memory'],
  [/^(set_timer|set_alert|cancel_alert|schedule_task|cancel_schedule|check_calendar)$/, 'timer'],
  [/^(arrange_panels|control_window|stop_listening)$/, 'hud'],
  [/^(open_|list_folder|create_folder|write_text_file|move_or_rename|delete_to_trash|run_command|set_volume|run_skill|skill_)/, 'system'],
];

/** Short, quiet cues (well under the voice): a teletype for news, a sonar for searches… */
function playToolSfx(sound: ToolSfx) {
  switch (sound) {
    case 'news': // teletype
      [0, 0.05, 0.1].forEach((t) => tone(t, 0.03, 1400, 1400, 0.025, 'square'));
      break;
    case 'weather': // airy sweep
      tone(0, 0.35, 420, 900, 0.035);
      tone(0.18, 0.25, 1200, 1500, 0.02);
      break;
    case 'markets': // ticker
      tone(0, 0.06, 988, 988, 0.04, 'triangle');
      tone(0.07, 0.09, 1318, 1318, 0.04, 'triangle');
      break;
    case 'search': // sonar ping and its echo
      tone(0, 0.4, 1500, 1380, 0.045);
      tone(0.28, 0.3, 1500, 1380, 0.015);
      break;
    case 'read': // scanning line
      tone(0, 0.2, 600, 1600, 0.03, 'triangle');
      break;
    case 'wiki': // soft chime
      tone(0, 0.25, 1046, 1046, 0.035);
      tone(0.06, 0.3, 1318, 1318, 0.03);
      break;
    case 'screen': // shutter
      tone(0, 0.05, 2000, 800, 0.04, 'triangle');
      tone(0.06, 0.05, 1200, 1200, 0.03);
      break;
    case 'computer': // servo
      tone(0, 0.12, 300, 520, 0.035, 'triangle');
      tone(0.12, 0.1, 520, 320, 0.03, 'triangle');
      break;
    case 'create': // shimmer
      [880, 1108, 1318, 1760].forEach((f, i) => tone(i * 0.05, 0.18, f, f, 0.025));
      break;
    case 'memory': // two low notes
      tone(0, 0.16, 523, 523, 0.035);
      tone(0.1, 0.22, 784, 784, 0.03);
      break;
    case 'timer': // tick-tick
      tone(0, 0.03, 1760, 1760, 0.035, 'square');
      tone(0.12, 0.03, 1760, 1760, 0.035, 'square');
      break;
    case 'hud': // whoosh
      tone(0, 0.18, 320, 150, 0.035, 'triangle');
      break;
    case 'system': // relay click
      tone(0, 0.025, 220, 220, 0.04, 'square');
      tone(0.04, 0.025, 330, 330, 0.03, 'square');
      break;
    case 'link': // data link
      tone(0, 0.14, 740, 1480, 0.03);
      break;
  }
}

let lastToolSound = 0;

/** Plays the tool's cue (several tools started together make one sound). */
export function playToolSound(toolName: string) {
  if (!enabled || performance.now() - lastToolSound < 250) return;
  lastToolSound = performance.now();
  try {
    playToolSfx(TOOL_SOUNDS.find(([pattern]) => pattern.test(toolName))?.[1] ?? 'link');
  } catch {
    // cosmetic
  }
}

/** The same tools, each playing its sound when it runs (typed requests and both voice modes). */
export function withToolSounds<T extends Record<string, { execute?: (...args: never[]) => unknown }>>(tools: T): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      t.execute
        ? {
            ...t,
            execute: (...args: never[]) => {
              playToolSound(name);
              return t.execute!(...args);
            },
          }
        : t,
    ]),
  ) as T;
}
