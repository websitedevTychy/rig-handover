import { describe, expect, it } from 'vitest';
import { countStatuses } from '../src/digest/count.js';

const l = (status: string) => JSON.stringify({ at: 'x', job: 'j', status, owner: null });

describe('countStatuses', () => {
  it('counts per status and skips bad lines', () => {
    const text = [l('ok'), l('ok'), l('retry'), l('fail'), 'garbage', l('weird'), ''].join('\n');
    expect(countStatuses(text)).toEqual({ ok: 2, retry: 1, fail: 1 });
  });
});
