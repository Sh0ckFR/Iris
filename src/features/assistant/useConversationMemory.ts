import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Settings } from '../../lib/settings';
import { memoryStore } from '../../lib/memory';
import { knowledgeStore } from '../../lib/knowledge';
import { parseSummary, SUMMARY_SYSTEM } from './memoryTools';
import { isNewSession, SAVED_MESSAGES, SESSION_STARTED_AT, SUMMARY_AFTER, SUMMARY_KEEP, type ChatMessage } from './assistantShared';

/**
 * The conversation's memory: restored at launch (or archived for a fresh session), saved as it
 * goes, summarized when it grows (the summary replaces the older messages and notes lasting
 * facts and the knowledge graph's entities, in the same inexpensive call), archived when cleared.
 */

interface Options {
  live: MutableRefObject<{ messages: ChatMessage[]; settings: Settings }>;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  /** One-shot call to the chat brain (summaries). */
  generate: (system: string, content: string) => Promise<string>;
  /** A request is being answered (no summary meanwhile). */
  busy: boolean;
}

export function useConversationMemory({ live, messages, setMessages, generate, busy }: Options) {
  /** Summary of the messages up to `coveredId`, which are no longer sent to the model. */
  const summaryRef = useRef<{ text: string; coveredId: string } | null>(null);
  const summarizingRef = useRef(false);
  /** The saved conversation has been restored (nothing is saved before, not to overwrite it). */
  const [restored, setRestored] = useState(false);

  // At launch: long-term memory, and the saved conversation. A new session (the app was opened,
  // not just the page reloaded) starts empty unless Settings say to resume: the previous
  // conversation is archived as it is (no AI call), so recall_memory can still find it.
  useEffect(() => {
    let alive = true;
    void (async () => {
      await memoryStore.load();
      const saved = await memoryStore.loadConversation();
      if (!alive) return;
      if (saved?.messages?.length) {
        if (isNewSession && !live.current.settings.resumeConversation) {
          memoryStore.archiveConversation(saved.messages.filter((m) => m.content), saved.summary?.text ?? null);
          memoryStore.saveConversation({ messages: [], summary: null });
          console.warn(`[iris:memory] new session: previous conversation archived (${saved.messages.length} messages)`);
        } else {
          setMessages((prev) => (prev.length ? prev : saved.messages));
          summaryRef.current = saved.summary;
        }
      }
      setRestored(true);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Saves the conversation (text only), from a little before the summary point. */
  const persistConversation = useCallback(() => {
    const kept = live.current.messages.filter((m) => m.content && !m.error);
    const covered = kept.findIndex((m) => m.id === summaryRef.current?.coveredId);
    memoryStore.saveConversation({
      messages: kept
        .slice(Math.max(0, covered - 4))
        .slice(-SAVED_MESSAGES)
        .map(({ id, role, content, brain }) => ({ id, role, content, brain })),
      summary: summaryRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Lasting facts and graph entities found by a summary (when Iris may note them by herself). */
  const noteFindings = (parsed: NonNullable<ReturnType<typeof parseSummary>>) => {
    if (!live.current.settings.autoMemory) return;
    parsed.facts.forEach((fact) => memoryStore.addFact(fact, 'auto'));
    knowledgeStore.merge(parsed.graph);
  };

  /**
   * Once ~10 exchanges are not covered by the summary, the older ones are summarized (and the
   * lasting facts about the user they contain are remembered): one inexpensive call.
   */
  const summarize = useCallback(async () => {
    if (summarizingRef.current) return;
    const kept = live.current.messages.filter((m) => m.content && !m.error);
    const uncovered = kept.slice(kept.findIndex((m) => m.id === summaryRef.current?.coveredId) + 1);
    if (uncovered.length <= SUMMARY_AFTER) return;
    const batch = uncovered.slice(0, uncovered.length - SUMMARY_KEEP);
    summarizingRef.current = true;
    try {
      const transcript = batch.map((m) => `${m.role === 'user' ? 'User' : 'Iris'}: ${m.content.slice(0, 1500)}`).join('\n');
      const parsed = parseSummary(
        await generate(SUMMARY_SYSTEM, `Current summary:\n${summaryRef.current?.text || '(none)'}\n\nNew messages:\n${transcript}`),
      );
      if (!parsed) return;
      summaryRef.current = { text: parsed.summary, coveredId: batch[batch.length - 1].id };
      noteFindings(parsed);
      persistConversation();
      console.warn(
        `[iris:memory] summarized ${batch.length} messages; ${parsed.facts.length} fact(s), ${parsed.graph.entities.length} entities, ${parsed.graph.relations.length} relations noted`,
      );
    } catch (error) {
      console.warn('[iris:memory] summary failed', error);
    } finally {
      summarizingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generate, persistConversation]);

  // After each change, once the conversation is quiet: save it, and summarize if it grew.
  useEffect(() => {
    if (!restored) return;
    const timer = window.setTimeout(() => {
      persistConversation();
      if (!busy) void summarize();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [messages, busy, restored, persistConversation, summarize]);

  /** Long-term memory + summary of the earlier conversation, for the (cached) instructions. */
  const memoryContext = () => {
    const facts = memoryStore.promptFacts() || undefined;
    // A fresh conversation continues from the previous one's summary: always when resuming is on,
    // otherwise only for a conversation cleared (🗑) during this session.
    const last = live.current.messages.length < 4 ? memoryStore.lastJournalEntry() : null;
    const previous = last && (live.current.settings.resumeConversation || last.at >= SESSION_STARTED_AT) ? last : null;
    const earlier =
      summaryRef.current?.text ??
      (previous ? `(previous conversation, ${new Date(previous.at).toLocaleDateString(navigator.language)}) ${previous.summary}` : undefined);
    return { facts, earlier };
  };

  /**
   * The conversation is cleared: it is not lost — its summary goes to the long-term journal and
   * its text to the archive (recall_memory), in the background.
   */
  const archiveConversation = useCallback(() => {
    const finished = live.current.messages.filter((m) => m.content && !m.error);
    const previousSummary = summaryRef.current;
    summaryRef.current = null;
    if (finished.length < 2) return;
    void (async () => {
      let summary = previousSummary?.text ?? null;
      const rest = finished.slice(finished.findIndex((m) => m.id === previousSummary?.coveredId) + 1);
      if (rest.length) {
        try {
          const transcript = rest.map((m) => `${m.role === 'user' ? 'User' : 'Iris'}: ${m.content.slice(0, 1500)}`).join('\n');
          const parsed = parseSummary(await generate(SUMMARY_SYSTEM, `Current summary:\n${summary || '(none)'}\n\nNew messages:\n${transcript}`));
          if (parsed) {
            summary = parsed.summary;
            noteFindings(parsed);
          }
        } catch (error) {
          console.warn('[iris:memory] could not summarize the conversation', error);
        }
      }
      memoryStore.archiveConversation(finished, summary);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generate]);

  return { summaryRef, memoryContext, archiveConversation };
}
