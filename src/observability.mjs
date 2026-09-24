// Observability primitives: per-source request metrics and alarm evaluation.
//
// Design notes (no hallucinations):
// - Metrics are recorded by the Collector around real network attempts only.
//   Idle loop iterations that do no I/O record nothing.
// - Alarms are evaluated from recorded metrics + Engine health timestamps.
//   Thresholds are documented here and asserted in tests/observability.test.mjs.
// - Staleness alarms only apply while games are live. When no game is live the
//   injury/news loops intentionally do no network I/O, so "no recent success"
//   is the expected idle state, not an outage.
export const ALARM_THRESHOLDS = {
  // Consecutive failures before a source raises an alarm.
  consecutiveWarning: 2,
  consecutiveCritical: 3,
  // Milliseconds without a successful poll while games are live.
  staleCriticalMs: {
    'ESPN scoreboard': 90_000,
    'ESPN play-by-play': 90_000,
    'ESPN injuries': 90_000,
    'ESPN news': 180_000,
    'ESPN player news': 300_000,
    'NBA.com news index': 300_000
  }
};

export class SourceMetrics {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.counters = new Map();
  }
  record(name, ok, { error = '' } = {}) {
    const key = String(name);
    const entry = this.counters.get(key) || {
      attempts: 0, successes: 0, failures: 0, consecutiveFailures: 0,
      lastError: '', firstSeenAt: this.now(), lastCheckedAt: 0, lastOkAt: 0
    };
    entry.attempts += 1;
    entry.lastCheckedAt = this.now();
    if (ok) {
      entry.successes += 1;
      entry.consecutiveFailures = 0;
      entry.lastError = '';
      entry.lastOkAt = this.now();
    } else {
      entry.failures += 1;
      entry.consecutiveFailures += 1;
      entry.lastError = String(error || 'request failed').slice(0, 200);
    }
    this.counters.set(key, entry);
    return entry;
  }
  snapshot() {
    const out = {};
    for (const [name, entry] of this.counters) out[name] = { ...entry };
    return out;
  }
}

// health: Engine.health map { [sourceName]: { okAt, checkedAt, error } }
// metrics: SourceMetrics.snapshot() output
// Returns [{ name, severity: 'warning'|'critical', reason }]
export function evaluateAlarms({ health = {}, metrics = {}, now = Date.now(), live = false } = {}) {
  const alarms = [];
  const seen = new Set();
  const push = alarm => {
    const key = `${alarm.name}:${alarm.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    alarms.push(alarm);
  };

  for (const [name, entry] of Object.entries(metrics)) {
    const consecutive = Number(entry?.consecutiveFailures) || 0;
    if (consecutive >= ALARM_THRESHOLDS.consecutiveCritical) {
      push({ name, severity: 'critical', reason: `${consecutive} consecutive failures: ${entry.lastError || 'request failed'}`.slice(0, 220) });
    } else if (consecutive >= ALARM_THRESHOLDS.consecutiveWarning) {
      push({ name, severity: 'warning', reason: `${consecutive} consecutive failures: ${entry.lastError || 'request failed'}`.slice(0, 220) });
    }
  }

  // Durable storage failures are always critical, live or idle: without the
  // local store a restart loses incidents and the audit trail.
  if (health?.['Local event storage']?.error) {
    push({ name: 'Local event storage', severity: 'critical', reason: String(health['Local event storage'].error).slice(0, 220) });
  }
  if (health?.['Local audit storage']?.error) {
    push({ name: 'Local audit storage', severity: 'critical', reason: String(health['Local audit storage'].error).slice(0, 220) });
  }

  if (live) {
    for (const [name, staleMs] of Object.entries(ALARM_THRESHOLDS.staleCriticalMs)) {
      const okAt = Number(health?.[name]?.okAt) || Number(metrics?.[name]?.lastOkAt) || 0;
      // No success recorded yet while live: only alarm if we have also seen
      // failures (a fresh boot before the first poll is not an outage).
      const failures = Number(metrics?.[name]?.failures) || 0;
      const attempts = Number(metrics?.[name]?.attempts) || 0;
      if (!okAt) {
        if (failures > 0 && attempts > 0) {
          push({ name, severity: 'critical', reason: `no successful poll yet (${failures} failures while live)`.slice(0, 220) });
        }
        continue;
      }
      if (now - okAt > staleMs) {
        push({ name, severity: 'critical', reason: `no successful poll for ${Math.round((now - okAt) / 1000)}s (threshold ${Math.round(staleMs / 1000)}s)`.slice(0, 220) });
      }
    }
  }

  return alarms.sort((a, b) => a.name.localeCompare(b.name));
}

export function uptimeInfo({ startedAt = 0, now = Date.now() } = {}) {
  const start = Number(startedAt) || now;
  return { startedAt: start, uptimeMs: Math.max(0, now - start) };
}
