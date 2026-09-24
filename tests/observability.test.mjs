// Observability unit tests: metrics recording and alarm evaluation.
// No network, no invented provider shapes. Thresholds mirror
// src/observability.mjs ALARM_THRESHOLDS line by line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SourceMetrics, evaluateAlarms, uptimeInfo, ALARM_THRESHOLDS } from '../src/observability.mjs';
import { Collector } from '../src/collector.mjs';
import { urls } from '../src/sources.mjs';
import { GAME_ID, liveScoreboard, summary } from './fixtures.mjs';

const NOW = Date.parse('2026-10-03T23:30:00Z');

test('metrics record attempts, successes, failures and consecutive streaks', () => {
  let current = NOW;
  const metrics = new SourceMetrics({ now: () => current });
  metrics.record('ESPN scoreboard', true);
  current += 1000;
  metrics.record('ESPN scoreboard', false, { error: 'HTTP 503 (boom)' });
  current += 1000;
  metrics.record('ESPN scoreboard', false, { error: 'HTTP 503 (boom)' });
  const snap = metrics.snapshot();
  assert.equal(snap['ESPN scoreboard'].attempts, 3);
  assert.equal(snap['ESPN scoreboard'].successes, 1);
  assert.equal(snap['ESPN scoreboard'].failures, 2);
  assert.equal(snap['ESPN scoreboard'].consecutiveFailures, 2);
  assert.match(snap['ESPN scoreboard'].lastError, /HTTP 503/);
  assert.equal(snap['ESPN scoreboard'].lastOkAt, NOW);
  assert.equal(snap['ESPN scoreboard'].lastCheckedAt, NOW + 2000);
  // A success resets the consecutive streak but keeps totals.
  current += 1000;
  metrics.record('ESPN scoreboard', true);
  const after = metrics.snapshot()['ESPN scoreboard'];
  assert.equal(after.attempts, 4);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.lastError, '');
});

test('consecutive failures raise warning then critical alarms', () => {
  const metrics = new SourceMetrics({ now: () => NOW });
  // Thresholds are part of the operator contract; assert the documented values.
  assert.equal(ALARM_THRESHOLDS.consecutiveWarning, 2);
  assert.equal(ALARM_THRESHOLDS.consecutiveCritical, 3);
  metrics.record('ESPN injuries', false, { error: 'fetch failed' });
  assert.deepEqual(evaluateAlarms({ metrics: metrics.snapshot(), now: NOW, live: false }), []);
  metrics.record('ESPN injuries', false, { error: 'fetch failed' });
  assert.deepEqual(evaluateAlarms({ metrics: metrics.snapshot(), now: NOW, live: false }), [
    { name: 'ESPN injuries', severity: 'warning', reason: '2 consecutive failures: fetch failed' }
  ]);
  metrics.record('ESPN injuries', false, { error: 'HTTP 503' });
  assert.deepEqual(evaluateAlarms({ metrics: metrics.snapshot(), now: NOW, live: false }), [
    { name: 'ESPN injuries', severity: 'critical', reason: '3 consecutive failures: HTTP 503' }
  ]);
});

test('stale sources alarm only while live; fresh boot without failures is not an outage', () => {
  const health = { 'ESPN scoreboard': { okAt: NOW - 30_000, checkedAt: NOW, error: '' } };
  // Fresh data while live: no alarm.
  assert.deepEqual(evaluateAlarms({ health, metrics: {}, now: NOW, live: true })
    .filter(a => a.name === 'ESPN scoreboard'), []);
  // Stale data while live: critical.
  const stale = { 'ESPN scoreboard': { okAt: NOW - 200_000, checkedAt: NOW, error: 'HTTP 503' } };
  const alarms = evaluateAlarms({ health: stale, metrics: {}, now: NOW, live: true });
  assert.ok(alarms.some(a => a.name === 'ESPN scoreboard' && a.severity === 'critical'),
    `expected a stale critical alarm, got ${JSON.stringify(alarms)}`);
  // Same staleness while idle: no alarm (injury/news loops do no I/O when idle).
  assert.deepEqual(evaluateAlarms({ health: stale, metrics: {}, now: NOW, live: false })
    .filter(a => a.name === 'ESPN scoreboard'), []);
  // No success yet, but also no failures (fresh boot): no alarm.
  assert.deepEqual(evaluateAlarms({ health: {}, metrics: {}, now: NOW, live: true })
    .filter(a => a.name === 'ESPN scoreboard'), []);
  // No success yet with failures while live: critical.
  const m = new SourceMetrics({ now: () => NOW });
  m.record('ESPN scoreboard', false, { error: 'fetch failed' });
  assert.ok(evaluateAlarms({ health: {}, metrics: m.snapshot(), now: NOW, live: true })
    .some(a => a.name === 'ESPN scoreboard' && a.severity === 'critical'));
});

test('storage failures are always critical, live or idle', () => {
  const health = { 'Local event storage': { checkedAt: NOW, error: 'Cannot persist state: EROFS' } };
  for (const live of [false, true]) {
    const alarms = evaluateAlarms({ health, metrics: {}, now: NOW, live });
    assert.deepEqual(alarms, [{ name: 'Local event storage', severity: 'critical', reason: 'Cannot persist state: EROFS' }]);
  }
  const audit = { 'Local audit storage': { checkedAt: NOW, error: 'Audit log write failed' } };
  assert.equal(evaluateAlarms({ health: audit, metrics: {}, now: NOW, live: false })[0].name, 'Local audit storage');
});

test('uptime info reports monotonic milliseconds since start', () => {
  assert.deepEqual(uptimeInfo({ startedAt: NOW, now: NOW + 5000 }), { startedAt: NOW, uptimeMs: 5000 });
  assert.deepEqual(uptimeInfo({ startedAt: 0, now: NOW }), { startedAt: NOW, uptimeMs: 0 });
});

test('collector records per-source metrics and exposes alarms; idle loops record no I/O', async () => {
  const dir = join(tmpdir(), `nba-metrics-${randomUUID()}`);
  const path = join(dir, 'state.json');
  const client = { json: async (_key, url) => {
    if (url === urls.scoreboard('2026-10-02')) throw new Error('Test: yesterday unavailable');
    if (url === urls.scoreboard('2026-10-03')) return liveScoreboard();
    if (url === urls.summary(GAME_ID)) return summary();
    if (url === urls.nbaScoreboard) throw new Error('Test: NBA CDN blocked');
    throw new Error(`Unexpected fixture URL: ${url}`);
  } };
  const collector = new Collector({ now: () => NOW, statePath: path, client });
  try {
    assert.equal(collector.startedAt, NOW);
    assert.deepEqual(collector.metrics.snapshot(), {}, 'no attempts before the first tick');
    // Idle injury/news loops do no I/O when no game is live yet: no metrics.
    await collector.injuryTick();
    await collector.newsTick();
    assert.deepEqual(collector.metrics.snapshot(), {}, 'idle loops must not fabricate request counts');
    await collector.scoreboardTick();
    await collector.writeQueue;
    const snap = collector.metrics.snapshot();
    assert.equal(snap['ESPN scoreboard'].successes, 1);
    assert.equal(snap['ESPN previous-day scoreboard'].failures, 1);
    assert.equal(snap['NBA official scoreboard'].failures, 1);
    assert.equal(snap['Local event storage'].successes >= 1, true);
    // One failure is below the warning threshold: no alarm yet.
    assert.deepEqual(collector.alarms().filter(a => a.name === 'NBA official scoreboard'), []);
    await collector.scoreboardTick();
    await collector.scoreboardTick();
    const alarms = collector.alarms();
    assert.ok(alarms.some(a => a.name === 'NBA official scoreboard' && a.severity === 'critical'),
      `expected a critical CDN alarm after 3 consecutive failures, got ${JSON.stringify(alarms)}`);
    await collector.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
