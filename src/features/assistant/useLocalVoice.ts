import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Settings } from '../../lib/settings';
import { LocalWakeListener, type LocalWakeStatus, type SpeechEngine } from './localWake';
import { matchLocalCommand, type LocalCommand } from './localCommands';
import { isAddressedToIris } from './wakeWord';
import { playSfx } from './sfx';
import type { Speaker } from './tts';
import type { RealtimeSession } from './realtime';
import type { Attachment } from './documents';
import type { Task } from './assistantShared';
import { isEnrolling, keepKnownVoices, voiceStore, warmVoiceRecognition, type VoiceCheck } from '../../lib/voiceprint';

/**
 * Always-on listening on this computer (localWake.ts) and what a sentence heard means: a request
 * ("Iris, …", or the answer to a question she has just asked), a spoken answer to an approval
 * ("oui, vas-y"), or nothing for Iris (people chatting, her own echo). Talking over her pauses
 * her; without her name, she carries on. When she listens only to known voices (lib/voiceprint.ts),
 * a sentence that would do something is first checked: an unknown voice is ignored, and in a
 * longer sentence only what a known voice said is kept (then transcribed again).
 */

export interface VoiceInput {
  send: (text: string, attachments?: Attachment[], options?: { voice?: boolean }) => Promise<void>;
  startVoice: (wakeUp?: { audio: Float32Array; text: string }) => Promise<void>;
  runLocalCommand: (command: LocalCommand, text: string, source: Task['source']) => Promise<boolean>;
  /** A spoken "oui" / "non" while an approval waits: answers it (true when it did). */
  answerApproval: (text: string) => boolean;
  /** An approval is waiting for an answer. */
  approvalPending: () => boolean;
  stopSpeaking: () => void;
}

interface Options {
  /** Listening is possible (a brain for economy voice, an OpenAI key for premium). */
  listening: boolean;
  voiceActive: boolean;
  live: MutableRefObject<{ settings: Settings }>;
  speaker: Speaker;
  sessionRef: MutableRefObject<RealtimeSession | null>;
  ttsBusyRef: MutableRefObject<boolean>;
  followUpFromRef: MutableRefObject<number>;
  followUpUntilRef: MutableRefObject<number>;
  /** Latest callbacks (the listener lives as long as `listening` doesn't change). */
  input: MutableRefObject<VoiceInput>;
  setLevel: (level: number) => void;
}

export function useLocalVoice({ listening, voiceActive, live, speaker, sessionRef, ttsBusyRef, followUpFromRef, followUpUntilRef, input, setLevel }: Options) {
  const [wakeStatus, setWakeStatus] = useState<{ status: LocalWakeStatus; detail?: string }>({ status: 'off' });
  const [engine, setEngine] = useState<SpeechEngine | undefined>(undefined);
  const listenerRef = useRef<LocalWakeListener | null>(null);
  const holdTimerRef = useRef<number | undefined>(undefined);

  // ---- cutting Iris off: she pauses when the user starts talking, then listens or carries on.
  const releaseHold = useCallback(() => {
    window.clearTimeout(holdTimerRef.current);
    if (speaker.isHeld) speaker.release();
  }, [speaker]);
  const onSpeechStart = useCallback(() => {
    if (!live.current.settings.bargeIn || sessionRef.current || !ttsBusyRef.current) return;
    if (!speaker.hold()) return;
    console.warn('[iris:voice] the user started talking: Iris pauses');
    // Never stuck in pause (a long noise, a sentence Whisper drops without telling).
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(releaseHold, 12_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker, releaseHold]);

  /** What a sentence heard means (once its voice is known, see onSpeech). */
  const handle = (text: string, audio: Float32Array, startedAt: number) => {
    const { send, startVoice, runLocalCommand, answerApproval, stopSpeaking } = input.current;
    // An approval is waiting: "oui" / "non" answers it (her name not needed).
    if (answerApproval(text)) {
      window.clearTimeout(holdTimerRef.current);
      if (speaker.isHeld) stopSpeaking();
      return;
    }
    const addressed = isAddressedToIris(text);
    // Heard while Iris was speaking (she paused): only her name makes it a request. Anything else —
    // people talking in the room, her own echo, a noise — and she carries on where she stopped.
    const overIris = speaker.isHeld || (ttsBusyRef.current && live.current.settings.voiceMode !== 'realtime');
    if (overIris && !addressed) {
      console.warn(`[iris:voice] heard over Iris without her name, she carries on: "${text}"`);
      releaseHold();
      return;
    }

    if (live.current.settings.voiceMode === 'realtime') {
      // Premium: the cloud session listens itself once open; locally, only the name wakes it.
      if (sessionRef.current || !addressed) {
        console.warn(`[iris:wake] heard (not for Iris): "${text}"`);
        return;
      }
      console.warn(`[iris:wake] woken by: "${text}"`);
      const command = matchLocalCommand(text);
      void (async () => {
        if (command && command.kind !== 'attention' && (await runLocalCommand(command, text, 'voice'))) return;
        void startVoice({ audio, text });
      })();
      return;
    }

    // Economy: the local transcript is the request, answered by the text brain (or locally).
    // Without her name, only the answer to a question she has just asked (see the follow-up window).
    const followUp = startedAt >= followUpFromRef.current && startedAt <= followUpUntilRef.current;
    if (!addressed && !followUp) {
      console.warn(`[iris:wake] heard (not for Iris): "${text}"`);
      return;
    }
    console.warn(`[iris:voice] request${addressed ? '' : ' (answer to her question)'}: "${text}"`);
    followUpUntilRef.current = 0;
    // Talking to Iris while she speaks cuts her off: what she was saying is dropped, she listens.
    window.clearTimeout(holdTimerRef.current);
    if (ttsBusyRef.current || speaker.isHeld) stopSpeaking();
    playSfx('listen');
    void send(text, [], { voice: true });
  };

  /** A sentence heard on this computer: is it for Iris, from a voice she listens to? */
  const onSpeech = useCallback((text: string, audio: Float32Array, startedAt: number) => {
    if (isEnrolling()) return; // a voice being recorded: its sentences are not requests
    const { settings } = live.current;
    const overIris = speaker.isHeld || (ttsBusyRef.current && settings.voiceMode !== 'realtime');
    const followUp = settings.voiceMode !== 'realtime' && !overIris && startedAt >= followUpFromRef.current && startedAt <= followUpUntilRef.current;
    const mayAct = input.current.approvalPending() || isAddressedToIris(text) || followUp;
    if (!settings.voiceLock || voiceStore.all.length === 0 || !mayAct) {
      handle(text, audio, startedAt);
      return;
    }
    void (async () => {
      let check: VoiceCheck;
      try {
        check = await keepKnownVoices(audio);
      } catch (error) {
        console.warn('[iris:voices] voice check failed, sentence ignored', error);
        if (overIris) releaseHold();
        return;
      }
      console.warn(`[iris:voices] ${check.kept} (${check.name ?? '?'} ${check.score.toFixed(2)}): "${text}"`);
      if (check.kept === 'none') {
        if (overIris) releaseHold();
        return;
      }
      let heard = text;
      if (check.kept === 'part') {
        // Someone else spoke too: only the known voice's words are transcribed again.
        const again = await listenerRef.current?.retranscribe(check.audio);
        if (!again) {
          if (overIris) releaseHold();
          return;
        }
        console.warn(`[iris:voices] kept only the known voice: "${again}"`);
        heard = again;
      }
      handle(heard, check.audio, startedAt);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!listening) return;
    const listener = new LocalWakeListener({
      onStatus: (status, detail) => {
        if (status !== 'loading' || !detail) console.warn(`[iris:wake] ${status}${detail ? ` (${detail})` : ''}`);
        setWakeStatus({ status, detail });
      },
      onSpeech,
      onSpeechStart,
      onSpeechDropped: releaseHold,
      onEngine: setEngine,
      language: () => {
        const { language } = live.current.settings;
        return language === 'multi' ? null : language;
      },
      // The eye follows the microphone too: Iris visibly hears you.
      onLevel: (level) => {
        if (!sessionRef.current && !ttsBusyRef.current) setLevel(level);
      },
    });
    listenerRef.current = listener;
    // Listening to known voices only: the speaker model loads now, not at the first request.
    void voiceStore.load().then(() => live.current.settings.voiceLock && voiceStore.all.length > 0 && warmVoiceRecognition());
    if (sessionRef.current) listener.pause();
    void listener.start();
    return () => {
      listenerRef.current = null;
      void listener.stop();
      setWakeStatus({ status: 'off' });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, onSpeech, onSpeechStart, releaseHold]);

  // The premium (Realtime) session listens by itself while it is open.
  useEffect(() => {
    if (voiceActive) listenerRef.current?.pause();
    else listenerRef.current?.resume();
  }, [voiceActive]);

  return { wakeStatus: { ...wakeStatus, engine }, resumeListening: () => listenerRef.current?.resume() };
}
