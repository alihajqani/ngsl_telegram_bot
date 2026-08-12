import { describe, expect, it } from 'vitest';
import { cleanCueText, parseVtt, timestampToMs } from './vtt.js';

describe('timestampToMs', () => {
  it('parses hours, minutes, seconds, milliseconds', () => {
    expect(timestampToMs('01:02:03.456')).toBe(3_723_456);
  });

  it('treats the hour component as optional', () => {
    expect(timestampToMs('02:03.456')).toBe(123_456);
  });

  it('accepts SRT-style comma separators', () => {
    expect(timestampToMs('00:00:01,500')).toBe(1_500);
  });

  it('pads short fractions rather than misreading them as milliseconds', () => {
    expect(timestampToMs('00:00:01.5')).toBe(1_500);
  });
});

describe('cleanCueText', () => {
  it('strips styling and inline karaoke timing tags', () => {
    expect(cleanCueText('<c.colorE5E5E5>hello</c> <00:00:01.234>world')).toBe('hello world');
  });

  it('decodes HTML entities', () => {
    expect(cleanCueText('salt &amp; pepper &lt;here&gt; &#39;quoted&#39;')).toBe(
      "salt & pepper <here> 'quoted'",
    );
  });

  it('removes speaker-change markers and dialogue dashes', () => {
    expect(cleanCueText('>> Hello there')).toBe('Hello there');
    expect(cleanCueText('- And you?')).toBe('And you?');
  });

  it('collapses whitespace across wrapped lines', () => {
    expect(cleanCueText('hello\n   world  ')).toBe('hello world');
  });
});

describe('parseVtt', () => {
  const VTT = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:04.000
First line here

cue-id-2
00:00:04.000 --> 00:00:07.500 align:start position:0%
Second line here
`;

  it('extracts cues with correct timings', () => {
    const cues = parseVtt(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 1_000, endMs: 4_000, text: 'First line here' });
  });

  it('ignores cue settings trailing the end timestamp', () => {
    expect(parseVtt(VTT)[1]?.endMs).toBe(7_500);
  });

  it('tolerates an optional cue identifier line', () => {
    expect(parseVtt(VTT)[1]?.text).toBe('Second line here');
  });

  it('skips NOTE, STYLE and header blocks', () => {
    const withNote = `WEBVTT

NOTE this is a comment
that spans lines

STYLE
::cue { color: white }

00:00:01.000 --> 00:00:02.000
Real text
`;
    const cues = parseVtt(withNote);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Real text');
  });

  it('handles CRLF line endings and a BOM', () => {
    const crlf = '﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n';
    expect(parseVtt(crlf)).toHaveLength(1);
  });

  it('drops zero-length and empty cues', () => {
    const bad = `WEBVTT

00:00:05.000 --> 00:00:05.000
Zero length

00:00:06.000 --> 00:00:07.000

`;
    expect(parseVtt(bad)).toHaveLength(0);
  });

  it('returns cues sorted by start time', () => {
    const unsorted = `WEBVTT

00:00:10.000 --> 00:00:12.000
Later

00:00:01.000 --> 00:00:03.000
Earlier
`;
    expect(parseVtt(unsorted).map((c) => c.text)).toEqual(['Earlier', 'Later']);
  });
});
