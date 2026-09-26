import type { Phase } from '../features/assistant/useAssistant';

/**
 * Events between the main window (where Iris runs) and the always-on-top mini window, which
 * only displays: main → mini status and voice level; mini → main "hello" to get the state.
 */
export interface MiniStatus {
  phase: Phase;
  status: string;
  /** Latest reply, shortened. */
  reply: string;
}

export const MINI_STATUS_EVENT = 'iris://mini-status';
export const MINI_LEVEL_EVENT = 'iris://mini-level';
export const MINI_HELLO_EVENT = 'iris://mini-hello';
