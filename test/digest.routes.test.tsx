import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { DigestRow } from '../src/digest/types.js';

// Fixture night 2026-10-28: four jobs, one null owner, one job with 3 retries,
// one fail, and one unparseable line. Night 2026-10-29: empty file.
const NIGHT = '2026-10-28';
const EMPTY = '2026-10-29';
const MISSING = '2026-10-31';

const lines = [
  '{"at":"2026-10-28T01:00:00+01:00","job":"lane/sync","status":"ok","owner":"ola"}',
  '{"at":"2026-10-28T01:05:00+01:00","job":"digest/render","status":"ok","owner":null}',
  '{"at":"2026-10-28T01:10:00+01:00","job":"fixtures/refresh","status":"retry","owner":"ola","error":"upstream 503"}',
  'this is not json',
  '{"at":"2026-10-28T01:11:00+01:00","job":"fixtures/refresh","status":"retry","owner":"ola","error":"upstream 503"}',
  '{"at":"2026-10-28T01:12:00+01:00","job":"fixtures/refresh","status":"retry","owner":"ola","error":"upstream 503"}',
  '{"at":"2026-10-28T01:13:00+01:00","job":"fixtures/refresh","status":"ok","owner":"ola"}',
  '{"at":"2026-10-28T01:20:00+01:00","job":"notes/backup","status":"fail","owner":"mia","error":"quota exceeded"}',
];

const JOBS_SORTED = ['digest/render', 'fixtures/refresh', 'lane/sync', 'notes/backup'];

let runsDir: string;

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-routes-'));
  writeFileSync(join(runsDir, `${NIGHT}.jsonl`), lines.join('\n') + '\n');
  writeFileSync(join(runsDir, `${EMPTY}.jsonl`), '');
});

function app() {
  return createApp({
    adapter: 'shim',
    installed: '2026-10-29T14:06:00+01:00',
    beatEverySeconds: 60,
    runsDir,
  });
}

// The <tr> blocks of the page that belong to a job, in document order.
function rowsFor(html: string, job: string): string[] {
  const trs = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  return trs.filter((tr) => tr.includes(job));
}

function openTag(tr: string): string {
  return tr.slice(0, tr.indexOf('>') + 1);
}

describe('GET /digest/:night (HTML)', () => {
  it('200 for a night with a file, one table row per job, sorted by job', async () => {
    const res = await app().request(`/digest/${NIGHT}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<table');
    for (const job of JOBS_SORTED) {
      expect(rowsFor(html, job)).toHaveLength(1);
    }
    const positions = JOBS_SORTED.map((job) => html.indexOf(job));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('renders a null owner as —', async () => {
    const html = await (await app().request(`/digest/${NIGHT}`)).text();
    const tr = rowsFor(html, 'digest/render')[0];
    expect(tr).toContain('—');
  });

  it('marks rows with 3+ retries or any fail with class warn', async () => {
    const html = await (await app().request(`/digest/${NIGHT}`)).text();
    expect(openTag(rowsFor(html, 'fixtures/refresh')[0])).toMatch(/class="[^"]*\bwarn\b/);
    expect(openTag(rowsFor(html, 'notes/backup')[0])).toMatch(/class="[^"]*\bwarn\b/);
    expect(openTag(rowsFor(html, 'lane/sync')[0])).not.toMatch(/\bwarn\b/);
    expect(openTag(rowsFor(html, 'digest/render')[0])).not.toMatch(/\bwarn\b/);
  });

  it('empty file → 200 and the text "nothing ran"', async () => {
    const res = await app().request(`/digest/${EMPTY}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('nothing ran');
  });

  it('no file → 404', async () => {
    const res = await app().request(`/digest/${MISSING}`);
    expect(res.status).toBe(404);
  });

  it('a bad line → still 200, page shows the remaining jobs', async () => {
    const res = await app().request(`/digest/${NIGHT}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    for (const job of JOBS_SORTED) {
      expect(html).toContain(job);
    }
  });
});

describe('GET /api/digest/:night (JSON)', () => {
  it('200 → { night, rows, badLines } with rows sorted by job and null owner kept', async () => {
    const res = await app().request(`/api/digest/${NIGHT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { night: string; rows: DigestRow[]; badLines: number };
    expect(body.night).toBe(NIGHT);
    expect(body.rows.map((r) => r.job)).toEqual(JOBS_SORTED);
    expect(body.rows.find((r) => r.job === 'digest/render')?.owner).toBeNull();
    expect(body.rows.find((r) => r.job === 'fixtures/refresh')).toMatchObject({
      runs: 4,
      retries: 3,
      lastStatus: 'ok',
      lastError: 'upstream 503',
    });
    expect(body.rows.find((r) => r.job === 'notes/backup')).toMatchObject({
      lastStatus: 'fail',
      lastError: 'quota exceeded',
    });
  });

  it('empty file → 200, rows: [], badLines: 0', async () => {
    const res = await app().request(`/api/digest/${EMPTY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ night: EMPTY, rows: [], badLines: 0 });
  });

  it('no file → 404 with { error: "no run log for <night>" }', async () => {
    const res = await app().request(`/api/digest/${MISSING}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `no run log for ${MISSING}` });
  });

  it('a bad line → 200, badLines: 1', async () => {
    const res = await app().request(`/api/digest/${NIGHT}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { badLines: number };
    expect(body.badLines).toBe(1);
  });
});

describe('page and JSON agree', () => {
  it('job names in the HTML table appear in the same order as rows in the JSON', async () => {
    const html = await (await app().request(`/digest/${NIGHT}`)).text();
    const body = (await (await app().request(`/api/digest/${NIGHT}`)).json()) as { rows: DigestRow[] };
    const jsonOrder = body.rows.map((r) => r.job);
    const htmlOrder = jsonOrder
      .map((job) => ({ job, at: html.indexOf(job) }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.job);
    expect(htmlOrder).toEqual(jsonOrder);
  });
});
