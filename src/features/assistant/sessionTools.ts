import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

/** Voice-session control: "stop listening", "go to sleep", "leave us alone". */

export interface SessionHooks {
  /** Stops hearing the user now and ends the session once the acknowledgement has been spoken. */
  sleep: () => void;
}

const AFTER = 'You go back to standby: you hear nothing more until the user says your name ("Iris, …" or "…, Iris").';

export function createSessionTools(hooks: SessionHooks): ToolSet {
  return {
    stop_listening: tool({
      description: `Stop listening when the user asks you to stop listening, be quiet, go to sleep / standby, or leave them alone (e.g. "arrête d'écouter", "mets-toi en veille", "stop listening"). ${AFTER}`,
      inputSchema: z.object({}),
      execute: async () => {
        hooks.sleep();
        return {
          done: true,
          note: `Acknowledge in a few words only (e.g. "Très bien, je reste en veille." / "Very well, I'll be on standby."). ${AFTER}`,
        };
      },
    }),
  };
}
