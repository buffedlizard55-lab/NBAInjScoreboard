# Approved team / reporter / social sources

Team PR posts, credentialed beat reporters and X/Twitter content reach this
project **only through authenticated editorial intake**: a human verifies the
original post, its timestamp, the player and the game, then submits it to
`POST /api/reports` with `INJURY_INGEST_TOKEN`. There is no automatic
Twitter/X or team-PR scraping in this repository, and none is represented as
active anywhere in the UI or API.

Automatic collection of those channels may only be added after **all four**
of the following exist for that source, in this order:

1. **Source authorization** — a permission or licensed/contractual basis to
   collect from the account or feed, reviewed by a named operator
   (`authorization.basis`, `reviewedAt`, `reviewer`).
2. **Identity verification** — evidence the handle/account really belongs to
   the claimed team, reporter or outlet (`identity.method`, `verifiedAt`,
   `evidence`). A matching display name is not verification.
3. **Terms review** — the platform/API terms were read and permit the planned
   collection at the planned rate (`terms.reviewedAt`,
   `terms.policyUrl`/`terms.notes`).
4. **Replayable source captures** — verbatim payloads checked in under
   `tests/real/`, with a parser and a regression test that replays them
   (`captures[].path`, `capturedAt`, `provenance`, `parser`). This rule exists
   because the original injury parser shipped broken: its fixtures described a
   schema the live endpoint never sent, so 25 tests passed while production
   returned zero candidates. A capture is the only acceptable proof of shape.

## The registry

`config/approved-sources.json` lists team/reporter/social sources. It ships
with **zero entries** because none of the four prerequisites exist for any
such source. ESPN/NBA public feeds are not listed here; they are versioned
separately through `tools/probe.mjs`, `tests/real/*.json` and
`docs/verification.md`.

Entry schema (version 1, enforced by `src/approved-sources.mjs`):

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | always | Unique `[a-z0-9-]` slug, referenced as `sourceId` at intake. |
| `kind` | always | `team-pr`, `reporter` or `social`. |
| `publisher`, `description` | always | Display name and what the source covers. |
| `hosts` | ≥1 host or handle | Exact HTTPS hosts (no ports, userinfo or suffix matching). |
| `handles` | ≥1 host or handle | X/Twitter handles without `@`; cited only as `/status/<id>` URLs. |
| `authorization`, `identity`, `terms` | for `approved` / `autoPoll` | The checklist from items 1–3 above. |
| `captures` | for `autoPoll` | ≥1 capture whose file exists on disk (item 4). |
| `status` | always | `proposed`, `approved` or `suspended`. Suspended never matches. |
| `autoPoll` | always | `true` only when `status` is `approved` **and** the full checklist validates. |

Validate locally before proposing:

```sh
node tools/operator.mjs sources validate
node tools/operator.mjs sources validate --registry path/to/candidate.json
```

`tests/approved-sources.test.mjs` asserts the shipped registry validates and
that `approvedAutoSources()` is empty. Any future adapter that polls a
team/social URL automatically must refuse to run unless
`isApprovedForAuto(entry)` is true for its source id; adding the adapter
without the checklist must fail review and the test suite.

## Proposing a source (no code changes to polling)

1. Add a `status: "proposed"`, `autoPoll: false` entry with `hosts`/`handles`.
2. Run `sources validate` and `npm run check`.
3. Open a PR with the authorization, identity and terms evidence attached or
   referenced as on-file-with-operators. Do not commit private contact details
   or credentials; the registry file is public.
4. Editors can already attribute curated reports to the entry with
   `"sourceId": "<id>"` (see below) while it is proposed. That changes URL
   scoping, not automation.

## Approving automatic collection (all gates)

1. Complete items 1–3 with dates, reviewer and evidence in the entry.
2. Check in verbatim captures under `tests/real/`, write the parser, and add
   a regression test that replays the captures (mirror
   `tests/real-source.test.mjs`: assert the real shape, including which fields
   are absent).
3. Set `status: "approved"`, `autoPoll: true`, and confirm
   `isApprovedForAuto()` passes and the collector adapter calls it.
4. Record the CI probe observation for the new endpoint in
   `docs/verification.md` before merging.

## Editorial intake and `sourceId`

`POST /api/reports` accepts an optional `sourceId`. When present, the URL must
match that registry entry's hosts/handles and the entry must not be
suspended; when absent, the legacy allowlists (`nba.com`, `espn.com`,
`apnews.com`, `TRUSTED_SOURCE_HOSTS`, `TRUSTED_SOCIAL_HANDLES`) plus any
non-suspended registry entry apply. The audit trail records the `sourceId`
with each accepted/rejected report. Preflight locally first:

```sh
node tools/operator.mjs validate --file report.json
```

The server remains authoritative: its allowlist environment may differ from
the operator's shell, and only it enforces the live-game, participation and
duplicate gates.
