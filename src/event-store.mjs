// Durable append-only audit/event store.
//
// Files (inside the runtime dir, alongside state.json):
// - events.jsonl:   one line per state transition the collector publishes
//                   (new injury updates, review starts/outcome changes).
//                   Each line carries the full update/review payload so the
//                   feed can be replayed without the snapshot.
// - editorial.jsonl: one line per operator intake action (accepted, rejected,
//                   unauthorized use is NOT logged per-request to avoid
//                   disk-fill from unauthenticated scans; see server.mjs).
//
// Durability: appends use mkdir -p + appendFile and are chained on the
// collector's write queue so event lines and the state snapshot keep their
// order. Reads are bounded (last N lines). No rotation deletes history;
// archive the files externally instead of truncating them.
// Privacy: entries must never contain the ingest token. appendAudit strips
// token-like keys defensively and this is asserted in tests.
import { mkdir, appendFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FILES = { events: 'events.jsonl', editorial: 'editorial.jsonl', audit: 'editorial.jsonl' };
const SENSITIVE = new Set(['token', 'authorization', 'auth', 'bearer']);

function sanitize(entry) {
  if (!entry || typeof entry !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (SENSITIVE.has(String(key).toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

export class EventStore {
  constructor({ dir = '.runtime', now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
  }
  get eventsPath() { return join(this.dir, FILES.events); }
  get auditPath() { return join(this.dir, FILES.editorial); }
  async appendEvent(entry) {
    // The collector serializes lines synchronously at publish time; this only persists them.
    const line = typeof entry === 'string' ? entry : JSON.stringify({ at: new Date(this.now()).toISOString(), ...sanitize(entry) });
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.eventsPath, `${line}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
  }
  async appendAudit(entry) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), ...sanitize(entry) });
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(this.auditPath, `${line}\n`, 'utf8');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message || error).slice(0, 200) };
    }
  }
  async readRecent(kind, limit = 50) {
    const file = kind === 'events' ? this.eventsPath : this.auditPath;
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const lines = raw.split('\n').filter(line => line.trim());
    const out = [];
    for (const line of lines.slice(-bounded)) {
      try { out.push(JSON.parse(line)); }
      catch { /* skip a torn line rather than failing the whole read */ }
    }
    return out;
  }
  async sizes() {
    const out = {};
    for (const [kind, file] of [['events', this.eventsPath], ['editorial', this.auditPath]]) {
      try {
        const info = await stat(file);
        out[kind] = info.size;
      } catch {
        out[kind] = 0;
      }
    }
    return out;
  }
}
