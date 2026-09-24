// Durable audit/event store tests. Uses temp dirs only; asserts ordering,
// bounded reads, torn-line tolerance and that token-like keys never persist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../src/event-store.mjs';
import { Collector } from '../src/collector.mjs';
import { urls } from '../src/sources.mjs';
import { GAME_ID, liveScoreboard, summary, injury } from './fixtures.mjs';

const NOW = Date.parse('2026-10-03T23:30:00Z');

test('events and audit entries append in order and read back bounded', async () => {
  const dir = join(tmpdir(), `nba-events-${randomUUID()}`);
  try {
    const store = new EventStore({ dir, now: () => NOW });
    assert.deepEqual(await store.readRecent('events'), [], 'missing file reads as empty, not an error');
    assert.deepEqual(await store.readRecent('audit'), []);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await store.appendEvent({ kind: 'injury', id: `update-${i}` }), { ok: true });
      assert.deepEqual(await store.appendAudit({ action: 'report.accepted', id: `report-${i}` }), { ok: true });
    }
    const events = await store.readRecent('events');
    assert.equal(events.length, 5);
    assert.deepEqual(events.map(e => e.id), ['update-0', 'update-1', 'update-2', 'update-3', 'update-4']);
    assert.ok(events.every(e => e.at === new Date(NOW).toISOString()));
    const last2 = await store.readRecent('events', 2);
    assert.deepEqual(last2.map(e => e.id), ['update-3', 'update-4']);
    // Limit is clamped: 0 -> 50 default window, 9999 -> 200 max.
    assert.equal((await store.readRecent('events', 0)).length, 5);
    assert.equal((await store.readRecent('audit', 9999)).length, 5);
    const sizes = await store.sizes();
    assert.ok(sizes.events > 0 && sizes.editorial > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('collector publish appends a self-describing event line per state transition', async () => {
  const dir = join(tmpdir(), `nba-publish-${randomUUID()}`);
  const path = join(dir, 'state.json');
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.summary(GAME_ID)) return summary();
    if (url === urls.injuries) return injury();
    if (url === urls.nbaScoreboard) throw new Error('Test: NBA CDN blocked');
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: () => NOW, statePath: path, client });
  try {
    await collector.scoreboardTick();
    await collector.gameTick();
    await collector.injuryTick();
    await collector.writeQueue;
    const events = await collector.store.readRecent('events');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'injury');
    assert.equal(events[0].gameId, GAME_ID);
    // The line replays without the snapshot: full update payload included.
    assert.equal(events[0].update.player, 'Test Player');
    assert.equal(events[0].update.status, 'questionable');
    assert.match(events[0].update.evidence[0].source, /ESPN injury report/);
    assert.equal(events[0].at, new Date(NOW).toISOString());
    // A second identical poll corroborates without a new transition: no new line.
    await collector.injuryTick();
    await collector.writeQueue;
    assert.equal((await collector.store.readRecent('events')).length, 1);
    await collector.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('torn lines are skipped and token-like keys are never persisted', async () => {
  const dir = join(tmpdir(), `nba-audit-${randomUUID()}`);
  try {
    const store = new EventStore({ dir, now: () => NOW });
    await store.appendAudit({ action: 'report.accepted', gameId: '401999101', token: 'SECRET-TOKEN', Authorization: 'Bearer SECRET' });
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'editorial.jsonl'), 'NOT-JSON{{{torn\n', 'utf8');
    await store.appendAudit({ action: 'report.rejected', error: 'duplicate' });
    const entries = await store.readRecent('audit');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { at: new Date(NOW).toISOString(), action: 'report.accepted', gameId: '401999101' });
    assert.deepEqual(entries[1], { at: new Date(NOW).toISOString(), action: 'report.rejected', error: 'duplicate' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
