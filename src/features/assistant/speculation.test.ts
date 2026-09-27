import { describe, expect, it } from 'vitest';
import { Utterance } from './speculation';

const frame = () => new Float32Array(512);
/** Feeds `n` frames of speech (1) or silence (0). */
function feed(u: Utterance, n: number, speech: boolean, at = { t: 0 }) {
  for (let i = 0; i < n; i++) u.push(frame(), speech ? 0.9 : 0.05, (at.t += 32));
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('speculative transcription', () => {
  it('starts at a short pause, and a finished sentence is committed before the full silence', async () => {
    const u = new Utterance([frame(), frame()], 0);
    feed(u, 20, true);
    feed(u, 7, false);
    expect(u.wantsSpeculation()).toBe(false); // 0.22 s: not yet
    feed(u, 1, false);
    expect(u.wantsSpeculation()).toBe(true);
    let heard = 0;
    u.speculate(async (audio) => ((heard = audio.length), 'Iris, quelle heure est-il ?'));
    expect(heard).toBe((2 + 20 + 8) * 512);
    await flush();
    feed(u, 5, false);
    expect(u.readyToCommit()).toBeNull(); // 0.42 s: a natural pause, not the end yet
    feed(u, 4, false);
    expect(u.readyToCommit()).toBe('Iris, quelle heure est-il ?');
  });

  it('never commits her name alone: the request usually follows a breath later', async () => {
    const u = new Utterance([], 0);
    feed(u, 15, true);
    feed(u, 8, false);
    u.speculate(async () => 'Iris.');
    await flush();
    feed(u, 20, false);
    expect(u.readyToCommit()).toBeNull();
  });

  it('drops the speculation when the user goes on, and hears what follows a commit', async () => {
    const u = new Utterance([], 0);
    feed(u, 15, true);
    feed(u, 8, false);
    u.speculate(async () => 'Iris,');
    await flush();
    feed(u, 3, true); // "…, mets de la musique"
    expect(u.specCurrent()).toBe(false);
    expect(u.spec).toBeNull();
    feed(u, 20, false);
    expect(u.readyToCommit()).toBeNull(); // no current transcript: the detector's end decides

    const v = new Utterance([], 0);
    feed(v, 15, true);
    feed(v, 17, false);
    v.speculate(async () => 'Merci beaucoup.');
    await flush();
    const text = v.readyToCommit();
    expect(text).toBe('Merci beaucoup.');
    v.committed = v.frames.length;
    feed(v, 12, true);
    expect(v.spokeAfterCommit()).toBe(true);
  });

  it('does not commit an unfinished sentence', async () => {
    const u = new Utterance([], 0);
    feed(u, 15, true);
    feed(u, 8, false);
    u.speculate(async () => 'Iris, est-ce que tu peux');
    await flush();
    feed(u, 10, false);
    expect(u.readyToCommit()).toBeNull();
  });
});
