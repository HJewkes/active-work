import { describe, expect, it } from 'vitest';
import { closedTaskIds } from '../../src/sessions/report-resolves.js';

describe('closedTaskIds', () => {
  it('takes an id with closed, done or merged right beside it', () => {
    const text = 'SX-1 closed. Merged: SX-2. SX-3 is done. SX-4 (merged)';
    expect(closedTaskIds(text)).toEqual(['SX-1', 'SX-3', 'SX-4', 'SX-2']);
  });

  it('ignores ids that are only mentioned', () => {
    expect(closedTaskIds('Worked on SX-1; SX-2 stays open for the follow-up.')).toEqual([]);
  });

  it('ignores a negated close and the report Status line', () => {
    expect(closedTaskIds('Not closed SX-1. SX-2 not done.\nStatus: DONE SX-3')).toEqual([]);
  });

  it('lists each id once', () => {
    expect(closedTaskIds('SX-1 done; SX-1 merged')).toEqual(['SX-1']);
  });
});
