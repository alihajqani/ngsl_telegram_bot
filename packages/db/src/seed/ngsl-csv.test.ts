import { describe, expect, it } from 'vitest';
import { NgslCsvError, parseNgslCsv } from './ngsl-csv.js';

const HEADER = 'Lemma,SFI Rank,SFI,Adjusted Frequency per Million (U),definition';

const csv = (...lines: string[]) => [HEADER, ...lines].join('\n');

describe('parseNgslCsv', () => {
  it('maps the real column names onto the schema fields', () => {
    const rows = parseNgslCsv(csv('the,1,87.85,60910,used to refer to something already mentioned'));
    expect(rows).toEqual([
      {
        lemma: 'the',
        sfiRank: 1,
        sfi: 87.85,
        adjFreqPerMillion: 60910,
        definition: 'used to refer to something already mentioned',
      },
    ]);
  });

  it('keeps quoted definitions containing commas intact', () => {
    // 486 of the 2,809 real rows look like this. Splitting on commas corrupts them.
    const rows = parseNgslCsv(csv('have,8,81.53,14210,"to own, possess, or hold something"'));
    expect(rows[0]?.definition).toBe('to own, possess, or hold something');
    expect(rows[0]?.lemma).toBe('have');
  });

  it('treats blank numeric cells as undefined rather than zero', () => {
    const rows = parseNgslCsv(csv('thirst,2809,,,'));
    expect(rows[0]?.sfi).toBeUndefined();
    expect(rows[0]?.adjFreqPerMillion).toBeUndefined();
    expect(rows[0]?.definition).toBeUndefined();
    expect(rows[0]?.sfiRank).toBe(2809);
  });

  it('rejects a duplicate lemma', () => {
    const input = csv('run,1,80,100,to move fast', 'run,2,79,90,a jog');
    expect(() => parseNgslCsv(input)).toThrow(NgslCsvError);
    expect(() => parseNgslCsv(input)).toThrow(/duplicate lemma/i);
  });

  it('rejects a duplicate SFI Rank, which would make bucketing ambiguous', () => {
    const input = csv('run,5,80,100,to move fast', 'walk,5,79,90,to move slowly');
    expect(() => parseNgslCsv(input)).toThrow(/duplicate SFI Rank/i);
  });

  it('reports the offending line number for an invalid row', () => {
    const input = csv('ok,1,80,100,fine', ',2,79,90,missing lemma');
    // Header is line 1, so the bad row is line 3.
    expect(() => parseNgslCsv(input)).toThrow(/line 3/);
  });

  it('rejects a non-numeric rank', () => {
    expect(() => parseNgslCsv(csv('run,abc,80,100,to move fast'))).toThrow(NgslCsvError);
  });

  it('rejects an empty file', () => {
    expect(() => parseNgslCsv(HEADER)).toThrow(/no data rows/i);
  });

  it('strips a UTF-8 BOM from the first header cell', () => {
    const rows = parseNgslCsv('﻿' + csv('the,1,87.85,60910,a definition'));
    expect(rows[0]?.lemma).toBe('the');
  });
});
