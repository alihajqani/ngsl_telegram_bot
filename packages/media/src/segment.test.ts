import { describe, expect, it } from 'vitest';
import { countWords, endsSentence, segmentCues, stripNonSpeech } from './segment.js';
import { parseVtt } from './vtt.js';
import type { Cue } from './vtt.js';

const cue = (startMs: number, endMs: number, text: string): Cue => ({ startMs, endMs, text });

describe('endsSentence', () => {
  it('accepts terminal punctuation', () => {
    expect(endsSentence('The apple fell.')).toBe(true);
    expect(endsSentence('Why did it fall?')).toBe(true);
    expect(endsSentence('It fell!')).toBe(true);
    expect(endsSentence('He paused…')).toBe(true);
  });

  it('looks past closing quotes and brackets', () => {
    expect(endsSentence('He said "it fell."')).toBe(true);
    expect(endsSentence('(It fell.)')).toBe(true);
  });

  it('rejects unterminated text', () => {
    expect(endsSentence('and that is why the apple')).toBe(false);
  });

  it('does not treat an abbreviation as a sentence end', () => {
    // Without this, "Dr. King said" splits into two useless fragments.
    expect(endsSentence('We met Dr.')).toBe(false);
    expect(endsSentence('It costs 5 approx.')).toBe(false);
    expect(endsSentence('Cats vs.')).toBe(false);
  });

  it('does not treat an initial as a sentence end', () => {
    expect(endsSentence('It was written by J.')).toBe(false);
  });

  it('does not treat a dotted abbreviation as a sentence end', () => {
    expect(endsSentence('He moved to the U.S.')).toBe(false);
    expect(endsSentence('Bring a coat, e.g.')).toBe(false);
  });
});

describe('stripNonSpeech', () => {
  it('removes bracketed annotations and music marks', () => {
    expect(stripNonSpeech('[APPLAUSE] Thank you all. (laughter)')).toBe('Thank you all.');
    expect(stripNonSpeech('♪ la la la ♪ Hello')).toBe('la la la Hello');
  });
});

describe('countWords', () => {
  it('counts words and handles empty input', () => {
    expect(countWords('one two three')).toBe(3);
    expect(countWords('   ')).toBe(0);
  });
});

describe('segmentCues', () => {
  it('merges cues that break mid-sentence', () => {
    // The exact failure v1 shipped: a clip that ends on "the apple".
    const segments = segmentCues([
      cue(12_000, 15_000, "and that's why the apple"),
      cue(15_000, 18_000, 'fell from the tree in his garden.'),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("and that's why the apple fell from the tree in his garden.");
    expect(segments[0]?.startMs).toBe(12_000);
    expect(segments[0]?.endMs).toBe(18_000);
    expect(segments[0]?.complete).toBe(true);
  });

  it('splits two sentences packed into a single cue', () => {
    // Sentence ends do not line up with cue boundaries; a cue routinely carries
    // the end of one sentence and the start of the next.
    const segments = segmentCues([
      cue(0, 4_000, 'The apple fell down fast. Newton watched it happen closely.'),
    ]);
    expect(segments.map((s) => s.text)).toEqual([
      'The apple fell down fast.',
      'Newton watched it happen closely.',
    ]);
  });

  it('interpolates timing at an intra-cue split so starts stay distinct', () => {
    // Both sentences come from one cue. Giving them the cue's own bounds would
    // make them share a start_ms and collide on the (video_id, start_ms) index.
    const segments = segmentCues([
      cue(0, 4_000, 'The apple fell down fast. Newton watched it happen closely.'),
    ]);

    expect(segments[0]?.startMs).toBe(0);
    expect(segments[0]?.endMs).toBeGreaterThan(0);
    expect(segments[1]?.startMs).toBe(segments[0]?.endMs);
    expect(segments[1]?.endMs).toBe(4_000);
    expect(new Set(segments.map((s) => s.startMs)).size).toBe(segments.length);
  });

  it('carries a half-finished sentence across the cue boundary', () => {
    const segments = segmentCues([
      cue(0, 3_000, 'Good morning to everyone here. Today we will talk'),
      cue(3_000, 7_000, 'about how the apple became a symbol.'),
    ]);
    expect(segments.map((s) => s.text)).toEqual([
      'Good morning to everyone here.',
      'Today we will talk about how the apple became a symbol.',
    ]);
    // The second sentence begins partway through the first cue, not at its start.
    expect(segments[1]?.startMs).toBeGreaterThan(0);
    expect(segments[1]?.startMs).toBeLessThan(3_000);
    expect(segments[1]?.startMs).toBe(segments[0]?.endMs);
    expect(segments[1]?.endMs).toBe(7_000);
  });

  it('emits one segment per sentence across many cues', () => {
    const segments = segmentCues([
      cue(0, 3_000, 'The apple fell from the tree.'),
      cue(3_000, 6_000, 'Newton was sitting right there.'),
    ]);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.endMs).toBe(3_000);
    expect(segments[1]?.startMs).toBe(3_000);
  });

  it('drops fragments below the minimum word count', () => {
    expect(segmentCues([cue(0, 1_000, 'Yes.')])).toHaveLength(0);
  });

  it('flushes when a segment would exceed the duration cap', () => {
    // A speaker with no terminal punctuation must not produce a 60s "sentence".
    // Text must vary per cue, or the rolling-caption dedup correctly eats it.
    const cues = Array.from({ length: 12 }, (_, i) =>
      cue(i * 5_000, (i + 1) * 5_000, `talking on and on with no full stop part ${i}`),
    );
    const segments = segmentCues(cues, { maxDurationMs: 16_000 });

    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) {
      expect(s.endMs - s.startMs).toBeLessThanOrEqual(16_000);
    }
  });

  it('marks an unterminated segment as incomplete rather than discarding it', () => {
    const segments = segmentCues([cue(0, 3_000, 'this thought never actually finishes')]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.complete).toBe(false);
  });

  it('skips rolling-caption repeats', () => {
    const segments = segmentCues([
      cue(0, 2_000, 'the apple fell from the tree'),
      cue(2_000, 4_000, 'the apple fell from the tree'),
      cue(4_000, 6_000, 'onto the ground below him.'),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe('the apple fell from the tree onto the ground below him.');
  });

  it('handles a realistic VTT end to end', () => {
    const vtt = `WEBVTT
Kind: captions
Language: en

1
00:00:01.000 --> 00:00:04.500 align:start position:0%
<c>Good morning.</c> Today we will talk

2
00:00:04.500 --> 00:00:08.000
about how the apple &amp; the pear

3
00:00:08.000 --> 00:00:11.200
became symbols of discovery.

4
00:00:11.200 --> 00:00:13.000
[APPLAUSE]
`;
    const segments = segmentCues(parseVtt(vtt));

    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe(
      'Today we will talk about how the apple & the pear became symbols of discovery.',
    );
    // "Good morning." is split off but dropped as too short, so the surviving
    // segment starts after it — partway into the first cue.
    expect(segments[0]?.startMs).toBeGreaterThan(1_000);
    expect(segments[0]?.startMs).toBeLessThan(4_500);
    expect(segments[0]?.endMs).toBe(11_200);
  });
});
