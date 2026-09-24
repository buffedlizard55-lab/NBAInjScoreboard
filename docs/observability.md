# Observability and operations

How to tell the collector is alive, what it is failing at, where the durable
trail lives, and how operators work curated reports. All of this is exercised
by `tests/observability.test.mjs`, `tests/event-store.test.mjs`,
`tests/operator.test.mjs` and the live-server checks in
`docs/verification.md`.

## Endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | no | Service, ET day, `startedAt`/`uptimeMs`, `live`, `activeGames`, per-source health, request metrics, alarms. Poll this from uptime monitors. |
| `GET /api/metrics` | no | `startedAt`/`uptimeMs`, `live`, `activeGames`, per-source request counters, alarms. Same alarm evaluation as `/api/health`. |
| `GET /api/state?date=YYYY-MM-DD` | no | Scoreboard/injury/review snapshot plus `alarms` (hosted mode; the browser fallback omits the field). |
| `GET /api/sources` | no | Approved team/reporter registry exactly as the collector loaded it. |
| `GET /api/audit?limit=N` | ingest token | Recent intake actions (`report.accepted`/`report.rejected` with reason). Bounded to 200 entries. |
| `GET /api/events?limit=N` | ingest token | Recent state transitions with full update/review payloads. Bounded to 200 entries. |
| `POST /api/reports` | ingest token | Curated intake (see README and `docs/approved-sources.md`). |

## Uptime checks

Simplest monitor — HTTP 200 with no critical alarms:

```sh
node tools/operator.mjs health --check --host https://YOUR-HOST
echo $?  # 0 healthy, 1 critical alarms, 2 unreachable
```

Exit 1 means the process answers but a source dependency is failing (see
alarms below); exit 2 means the host did not answer within 8s. Any uptime
service can equivalently `GET /api/health` and alert on non-200 or on
`alarms[].severity === "critical"`. The process also needs supervision that
restarts it (`systemd`, `pm2`, Docker restart policy) and a reverse proxy for
HTTPS; see the README quick start.

## Metrics and alarms

`SourceMetrics` (`src/observability.mjs`) counts real network attempts only —
idle loop iterations that do no I/O record nothing, so a quiet offseason night
is not an outage. Each poller records success/failure with the last error;
`evaluateAlarms()` derives, sorted by source name:

- **Consecutive failures:** `warning` at 2, `critical` at 3
  (`ALARM_THRESHOLDS.consecutiveWarning/consecutiveCritical`).
- **Staleness while games are live** (no successful poll within the window):
  ESPN scoreboard / play-by-play / injuries 90s, ESPN news 180s, ESPN player
  news and NBA.com news index 300s. Idle collectors never raise staleness
  alarms, and a fresh boot with no failures yet is not an outage.
- **Storage:** any `Local event storage` or `Local audit storage` error is
  always `critical`, live or idle — without the local store a restart loses
  incidents and the audit trail.

Alarms appear in `/api/health`, `/api/metrics`, `/api/state` (hosted) and the
site health panel (critical alarms turn it red with an `Alarm: <source>`
line). Tune thresholds only in `src/observability.mjs` with its tests; the UI
and operator tool read whatever the collector evaluates.

## Durable audit/event store

Inside the runtime dir (default `.runtime/`, override with `NBA_STATE_FILE`):

| File | Content |
| --- | --- |
| `state.json` | Atomic snapshot (write temp + rename): games, injuries, reviews, dedup keys, health, pending candidates. Compacted view of current state. |
| `events.jsonl` | Append-only line per published state transition (new injury update, review start/outcome change) with the full payload, so the feed replays without the snapshot. Corroborating evidence that does not change status is not a new line; the snapshot holds it. |
| `editorial.jsonl` | Append-only audit of authenticated intake actions: `report.accepted` and `report.rejected` (with reason, game/athlete/status/source URL/`sourceId`). Unauthenticated requests are never logged per-request. |

Appends are chained on the collector's write queue so event lines and the
snapshot keep their order; failures surface as `Local event storage` /
`Local audit storage` health errors, metrics and critical alarms, and intake
returns a `warning` alongside `accepted: true` when the audit append fails.
Entries never contain the ingest token (`EventStore` strips token-like keys;
asserted in tests — verify with `grep -c "$INJURY_INGEST_TOKEN" .runtime/*`).

**Retention:** nothing in the collector deletes history. Archive
`events.jsonl`/`editorial.jsonl` externally (copy + truncate during a
maintenance window, or filesystem snapshots). Reads via the API and the
operator tool are bounded to the last 200 lines; torn lines are skipped.

## Operator tooling

```sh
npm run operator -- health --host https://YOUR-HOST
npm run operator -- metrics
npm run operator -- sources
npm run operator -- sources validate
INJURY_INGEST_TOKEN=... npm run operator -- audit --limit 20
INJURY_INGEST_TOKEN=... npm run operator -- events --limit 20
npm run operator -- validate --file report.json
INJURY_INGEST_TOKEN=... npm run operator -- submit --file report.json
```

Host resolution: `--host`, else `NBA_COLLECTOR_URL`, else
`http://localhost:3000`. The token comes from the environment only — never as
a flag — and is never printed. `validate` runs the same `src/editorial.mjs`
checks as the server (URL allowlists, zoned timestamp, ids, 20–700 character
evidence, status enum, optional `sourceId` scoping) but the server is
authoritative: its allowlist environment may differ, and only it enforces the
live-game, participation and duplicate gates.

## On-call recovery (first pass)

1. `health --check` exit 2: the process or host is down. Check supervision
   (`systemctl status`, container restarts), the reverse proxy, and disk space
   for `.runtime/`. Restarting is safe: `state.json` rebuilds the slate and
   `pendingCandidates` resume the retry queue.
2. `health --check` exit 1: read `alarms[]`. A single-source `critical`
   (for example the NBA CDN `403` seen from CI runners) degrades coverage but
   the ESPN fallback keeps the slate live; check provider status before
   restarting anything. A `Local event storage` critical means the volume is
   read-only or full — fix storage, then confirm the next `publish()` clears
   the alarm.
3. Suspected missed or wrong alert: pull `/api/events?limit=200` and
   `/api/audit?limit=200`, compare against the cited source URLs, and record
   the outcome for the live-slate truth-set review described in
   `docs/verification.md`. Never edit `.runtime/state.json` by hand to "fix"
   an alert; submit a correction through intake so the audit trail stays
   complete.
