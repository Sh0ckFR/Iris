import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { memoryStore } from '../../lib/memory';
import { knowledgeStore, parseExtractedGraph, type ExtractedGraph } from '../../lib/knowledge';

/** remember / forget / recall_memory: the model's access to long-term memory (see lib/memory.ts). */
export function createMemoryTools(): ToolSet {
  return {
    remember: tool({
      description:
        'Remember a lasting fact about the user for future conversations: preferences, people and relationships, projects, habits, important dates ("mon manager s\'appelle Claire", "je suis végétarien"). Call it when the user asks you to remember something, or tells you something clearly worth remembering. Never store passwords, codes or other secrets.',
      inputSchema: z.object({
        fact: z.string().describe('One self-contained sentence in the user\'s language, e.g. "Le manager de l\'utilisateur s\'appelle Claire."'),
      }),
      execute: async ({ fact }) =>
        memoryStore.addFact(fact, 'user') ? { remembered: fact } : { remembered: false, note: 'Already known.' },
    }),

    forget: tool({
      description: 'Forget facts about the user that you remembered, when the user asks you to ("oublie mon adresse").',
      inputSchema: z.object({ what: z.string().describe('What to forget, e.g. "mon adresse"') }),
      execute: async ({ what }) => {
        const removed = [...memoryStore.forget(what).map((f) => f.text), ...knowledgeStore.forget(what).map((name) => `(knowledge graph) ${name}`)];
        return removed.length ? { forgotten: removed } : { forgotten: [], note: 'Nothing matching was remembered.' };
      },
    }),

    recall_memory: tool({
      description:
        'Search your long-term memory — facts about the user, summaries of past conversations and their text — for something from an earlier conversation that is not in your instructions ("what did we say about the trip last week?", "what was the name of that restaurant?").',
      inputSchema: z.object({ query: z.string().describe('Keywords of what you are looking for') }),
      execute: async ({ query }) => {
        const found = memoryStore.search(query);
        return found.length ? { found } : { found: [], note: 'Nothing about this in memory.' };
      },
    }),
  };
}

/**
 * One inexpensive call does all three jobs: a summary of the older messages (so they no longer
 * need to be sent), the lasting facts about the user found in them (long-term memory), and the
 * entities and relations of the knowledge graph.
 */
export const SUMMARY_SYSTEM = `You maintain the memory of Iris, a personal assistant.
You receive the current summary of a conversation (possibly empty) and newer messages. Reply with ONLY a JSON object, no markdown:
{"summary": "...", "facts": ["..."], "graph": {"entities": [{"name": "...", "type": "..."}], "relations": [{"from": "...", "to": "...", "label": "..."}]}}
- summary: an updated, self-contained summary of the whole conversation so far (previous summary + new messages), at most 150 words, in the language of the conversation. Keep what later questions may need: topics, decisions, names, figures, documents mentioned, requests still open. No pleasantries.
- facts: lasting facts about the user worth remembering in future conversations (preferences, people and relationships, projects, habits, important dates), one short self-contained sentence each, in the conversation's language. Only facts the user stated or clearly implied — not about the assistant, not temporary (weather, news), never secrets or passwords. Often an empty list.
- graph: the notable things of the NEW messages only, for a map of the user's world. entities: people, places, organizations, projects, topics, events and things that matter to the user (proper names preferred; at most 10; type is one of person, place, organization, project, topic, event, thing). relations: how they relate, as short phrases in the conversation's language ("manager de", "habite à", "travaille sur", "part en vacances à"); use "USER" for the user. Not the assistant, no secrets. Empty lists when nothing notable.`;

/** The model's reply to SUMMARY_SYSTEM, tolerant of code fences and stray text. */
export function parseSummary(text: string): { summary: string; facts: string[]; graph: ExtractedGraph } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(text.slice(start, end + 1)) as { summary?: unknown; facts?: unknown; graph?: unknown };
    if (typeof data.summary !== 'string' || !data.summary.trim()) return null;
    const facts = Array.isArray(data.facts) ? data.facts.filter((f): f is string => typeof f === 'string' && f.trim().length > 2) : [];
    return { summary: data.summary.trim(), facts: facts.slice(0, 10), graph: parseExtractedGraph(data.graph) };
  } catch {
    return null;
  }
}
