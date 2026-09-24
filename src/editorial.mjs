// Shared editorial-intake validation. The server and the operator CLI import
// the same functions so client-side preflight can never drift from what the
// collector enforces. The server remains authoritative: operator-side env
// allowlists may differ from the collector's, so a preflight pass does not
// guarantee acceptance.
import { sourceAllowsUrl, findSourcesForUrl } from './approved-sources.mjs';

export const str = value => value == null ? '' : String(value);
export const EDITORIAL_STATUSES = ['reported', 'questionable', 'out', 'confirmed_out', 'returned'];

// Legacy host/handle allowlist: exact HTTPS hosts (nba/espn/apnews by default
// plus TRUSTED_SOURCE_HOSTS), and X/Twitter /<handle>/status/<id> URLs for
// TRUSTED_SOCIAL_HANDLES. A trusted URL/handle is a link check, not proof the
// statement is authentic: the operator must inspect the source first.
export function approvedUrl(raw, { trustedHosts = '', trustedHandles = '' } = {}) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    const approved = ['nba.com', 'espn.com', 'apnews.com'];
    const custom = str(trustedHosts).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (approved.some(h => host === h || host.endsWith(`.${h}`)) || custom.includes(host)) return true;
    if (!['x.com', 'twitter.com'].includes(host)) return false;
    const handles = str(trustedHandles).split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean);
    const [handle, action, postId] = url.pathname.split('/').filter(Boolean);
    return handles.includes(str(handle).toLowerCase()) && action === 'status' && /^\d{8,25}$/.test(str(postId));
  } catch { return false; }
}

export function exactZonedTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(str(value));
  if (!match) return NaN;
  const [year, month, day, hour, minute, second = '0', fraction = ''] = match.slice(1);
  // Date.parse normalizes impossible dates (for example Feb 30), so validate the
  // source's calendar fields before accepting its claimed publication instant.
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(`${fraction}000`.slice(1, 4))));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 ||
    calendar.getUTCDate() !== Number(day) || calendar.getUTCHours() !== Number(hour) ||
    calendar.getUTCMinutes() !== Number(minute) || calendar.getUTCSeconds() !== Number(second)) return NaN;
  return Date.parse(str(value));
}

// Full field validation for POST /api/reports. Returns
// { ok, error, publishedAt, sourceId }. Live-game/participation/duplicate
// checks stay in Engine.curated; this covers shape, URL and timestamp only.
export function validateReport(body, { registry = null, trustedHosts = '', trustedHandles = '' } = {}) {
  const text = str(body?.text).trim();
  const name = str(body?.source).trim();
  const sourceId = str(body?.sourceId).trim();
  const publishedAt = exactZonedTimestamp(body?.publishedAt);
  let urlOk;
  if (sourceId) {
    const entry = registry?.sources?.find(s => s.id === sourceId);
    if (!entry) return { ok: false, error: 'Unknown sourceId; see /api/sources', publishedAt: NaN, sourceId };
    if (entry.status === 'suspended') return { ok: false, error: 'That approved source is suspended', publishedAt: NaN, sourceId };
    urlOk = sourceAllowsUrl(entry, body?.sourceUrl);
  } else {
    urlOk = approvedUrl(body?.sourceUrl, { trustedHosts, trustedHandles }) ||
      (registry ? findSourcesForUrl(registry, body?.sourceUrl).length > 0 : false);
  }
  if (!urlOk) return { ok: false, error: 'Source URL is not from a trusted host, approved source, or verified social handle', publishedAt: NaN, sourceId };
  if (text.length < 20 || text.length > 700) return { ok: false, error: 'Evidence text must be 20-700 characters', publishedAt: NaN, sourceId };
  if (name.length < 3 || name.length > 80) return { ok: false, error: 'Source name must be 3-80 characters', publishedAt: NaN, sourceId };
  if (!Number.isFinite(publishedAt)) return { ok: false, error: 'publishedAt must be a zoned ISO timestamp (Z or numeric offset)', publishedAt: NaN, sourceId };
  if (!/^[1-9]\d{0,11}$/.test(str(body?.athleteId))) return { ok: false, error: 'athleteId must be an ESPN athlete id', publishedAt: NaN, sourceId };
  if (!/^\d{6,12}$/.test(str(body?.gameId))) return { ok: false, error: 'gameId must be an ESPN event id', publishedAt: NaN, sourceId };
  if (!EDITORIAL_STATUSES.includes(body?.status)) return { ok: false, error: `status must be one of ${EDITORIAL_STATUSES.join(', ')}`, publishedAt: NaN, sourceId };
  return { ok: true, error: '', publishedAt, sourceId };
}
