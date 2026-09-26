/**
 * What Iris is saying, sentence by sentence, as it is heard — so the HUD can follow the
 * narration (a map flies to the place she names). A plain window event: no coupling between the
 * voice and the widgets.
 */

const EVENT = 'iris:sentence';

export function announceSentence(text: string) {
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: text }));
}

/** Calls `listener` with each sentence Iris starts saying; returns the unsubscribe function. */
export function onSentence(listener: (text: string) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
