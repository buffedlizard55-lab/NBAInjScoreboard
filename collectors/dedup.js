/**
 * Deduplication logic
 * - Same (sport, team, player, status) in last 5 minutes = skip
 * - Status upgrade (REPORTED → OUT) = emit new
 * - Stale posts (>30 min old) = discard
 */

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const STALE_WINDOW_MS = 30 * 60 * 1000;

const STATUS_PRIORITY = {
  'INJURY_REPORTED': 1,
  'QUESTIONABLE_TO_RETURN': 2,
  'OUT_FOR_GAME': 3,
  'RETURNED': 4 // returned is separate but higher
};

export class Deduper {
  constructor({ dedupWindowMs = DEDUP_WINDOW_MS, staleWindowMs = STALE_WINDOW_MS } = {}) {
    this.dedupWindowMs = dedupWindowMs;
    this.staleWindowMs = staleWindowMs;
    // Map of key -> { lastSeenMs, lastStatus, lastAlert }
    this.seen = new Map();
  }

  makeKey(alert) {
    const sport = String(alert.sport || '').toLowerCase();
    const team = String(alert.team || '').toUpperCase();
    const player = String(alert.player_name || '').toLowerCase().trim();
    const status = String(alert.status || '');
    return `${sport}|${team}|${player}|${status}`;
  }

  makeBaseKey(alert) {
    // Without status, for upgrade detection
    const sport = String(alert.sport || '').toLowerCase();
    const team = String(alert.team || '').toUpperCase();
    const player = String(alert.player_name || '').toLowerCase().trim();
    return `${sport}|${team}|${player}`;
  }

  isStale(alert, now = Date.now()) {
    try {
      const sourceTime = Date.parse(alert.timestamp_source);
      if (!Number.isFinite(sourceTime)) return true;
      const age = now - sourceTime;
      return age > this.staleWindowMs || age < -2 * 60 * 1000; // also reject future >2min
    } catch {
      return true;
    }
  }

  shouldEmit(alert, now = Date.now()) {
    if (this.isStale(alert, now)) {
      return { emit: false, reason: 'stale' };
    }

    const key = this.makeKey(alert);
    const baseKey = this.makeBaseKey(alert);
    const existing = this.seen.get(key);
    const nowMs = now;

    // Check same exact alert in window
    if (existing) {
      const age = nowMs - existing.lastSeenMs;
      if (age < this.dedupWindowMs) {
        return { emit: false, reason: 'duplicate', existing };
      }
    }

    // Check for status upgrade: same player/team/sport but higher priority
    // Look for any entry with same baseKey but different status
    let maxPriorityForPlayer = 0;
    let lastStatusForPlayer = null;
    for (const [k, v] of this.seen) {
      if (k.startsWith(baseKey + '|') || k === baseKey) {
        // k includes status at end, but baseKey is prefix
        const parts = k.split('|');
        const st = parts[3];
        const pri = STATUS_PRIORITY[st] || 0;
        if (v.lastSeenMs > nowMs - this.dedupWindowMs) {
          if (pri > maxPriorityForPlayer) {
            maxPriorityForPlayer = pri;
            lastStatusForPlayer = st;
          }
        }
      }
    }

    const currentPriority = STATUS_PRIORITY[alert.status] || 0;
    if (lastStatusForPlayer && maxPriorityForPlayer > 0) {
      if (currentPriority > maxPriorityForPlayer) {
        // upgrade - emit new
        this.seen.set(key, { lastSeenMs: nowMs, lastStatus: alert.status, lastAlert: alert });
        // also update base tracking
        this.cleanup(nowMs);
        return { emit: true, reason: 'upgrade', previousStatus: lastStatusForPlayer };
      }
      if (currentPriority < maxPriorityForPlayer) {
        // downgrade - skip unless explicit new incident (we skip for now)
        // But if it's RETURNED after OUT, that is allowed as new
        if (alert.status === 'RETURNED') {
          // allow returned after out
          this.seen.set(key, { lastSeenMs: nowMs, lastStatus: alert.status, lastAlert: alert });
          this.cleanup(nowMs);
          return { emit: true, reason: 'returned' };
        }
        return { emit: false, reason: 'downgrade', previousStatus: lastStatusForPlayer };
      }
    }

    // No duplicate, emit
    this.seen.set(key, { lastSeenMs: nowMs, lastStatus: alert.status, lastAlert: alert });
    this.cleanup(nowMs);
    return { emit: true, reason: 'new' };
  }

  cleanup(nowMs) {
    // Remove entries older than dedup window to prevent unbounded growth
    for (const [k, v] of this.seen) {
      if (nowMs - v.lastSeenMs > this.dedupWindowMs * 2) {
        this.seen.delete(k);
      }
    }
  }

  clear() {
    this.seen.clear();
  }

  size() {
    return this.seen.size;
  }
}

// Singleton for main loop
export const globalDeduper = new Deduper();

export function dedupAlert(alert, deduper = globalDeduper) {
  return deduper.shouldEmit(alert);
}
