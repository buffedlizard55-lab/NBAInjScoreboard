// Approved team/reporter/social source registry.
//
// Team PR posts, credentialed beat reporters and X/Twitter content currently
// reach the collector ONLY through authenticated editorial intake (a human
// verifies the original post, timestamp, player and game). Automatic
// collection of those channels must NOT be added until each source has:
//   1. source authorization (permission or licensed/contractual basis),
//   2. identity verification (the handle/account really is who it claims),
//   3. terms review (platform/API terms allow the collection), and
//   4. replayable source captures (verbatim payloads checked in under
//      tests/real/ with a parser + regression test).
//
// This module defines the registry schema and the gates. The shipped
// config/approved-sources.json contains ZERO automatic team/social sources,
// and validateRegistry/isApprovedForAuto enforce the checklist above for any
// future addition. ESPN/NBA public feeds are versioned separately (probe +
// tests/real captures + docs/verification.md), not through this registry.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const REGISTRY_VERSION = 1;
const ID = /^[a-z0-9][a-z0-9-]{1,60}$/;
// X/Twitter handles: 1-15 chars, letters/numbers/underscore (platform rule).
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const KINDS = new Set(['team-pr', 'reporter', 'social']);
const STATUSES = new Set(['proposed', 'approved', 'suspended']);

function validHost(value) {
  if (typeof value !== 'string') return false;
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253 || host.includes(':') || host.includes('@') || host.includes('/') || host.includes(' ')) return false;
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || host.startsWith('-')) return false;
  return /^[a-z0-9.-]+$/.test(host);
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && Number.isFinite(Date.parse(value));
}
function nonEmpty(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

// Full structural validation. rootDir resolves capture paths (repo root).
// Returns an array of error strings; empty means valid.
export function validateSource(entry, { rootDir = process.cwd() } = {}) {
  const errors = [];
  if (!entry || typeof entry !== 'object') return ['source entry must be an object'];
  if (!ID.test(entry.id || '')) errors.push(`"${entry.id}" must match ${ID}`);
  if (!KINDS.has(entry.kind)) errors.push(`"${entry.id}": kind must be one of team-pr, reporter, social`);
  if (!nonEmpty(entry.publisher, 120)) errors.push(`"${entry.id}": publisher is required`);
  if (!nonEmpty(entry.description, 1000)) errors.push(`"${entry.id}": description is required`);
  const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
  const handles = Array.isArray(entry.handles) ? entry.handles : [];
  if (!hosts.length && !handles.length) errors.push(`"${entry.id}": at least one host or handle is required`);
  for (const host of hosts) if (!validHost(host)) errors.push(`"${entry.id}": invalid host "${host}"`);
  for (const handle of handles) if (!HANDLE.test(String(handle).replace(/^@/, ''))) errors.push(`"${entry.id}": invalid handle "${handle}"`);
  if (!STATUSES.has(entry.status)) errors.push(`"${entry.id}": status must be one of proposed, approved, suspended`);
  if (typeof entry.autoPoll !== 'boolean') errors.push(`"${entry.id}": autoPoll must be a boolean`);
  if (entry.autoPoll && entry.status !== 'approved') errors.push(`"${entry.id}": autoPoll requires status "approved"`);

  // Verification checklist: required in full before automatic collection.
  if (entry.autoPoll || entry.status === 'approved') {
    const auth = entry.authorization || {};
    const identity = entry.identity || {};
    const terms = entry.terms || {};
    if (!nonEmpty(auth.basis, 500)) errors.push(`"${entry.id}": authorization.basis is required`);
    if (!validDate(auth.reviewedAt || '')) errors.push(`"${entry.id}": authorization.reviewedAt must be a date`);
    if (!nonEmpty(auth.reviewer, 120)) errors.push(`"${entry.id}": authorization.reviewer is required`);
    if (!nonEmpty(identity.method, 500)) errors.push(`"${entry.id}": identity.method is required`);
    if (!validDate(identity.verifiedAt || '')) errors.push(`"${entry.id}": identity.verifiedAt must be a date`);
    if (!nonEmpty(identity.evidence, 500)) errors.push(`"${entry.id}": identity.evidence is required`);
    if (!validDate(terms.reviewedAt || '')) errors.push(`"${entry.id}": terms.reviewedAt must be a date`);
    if (!nonEmpty(terms.notes || terms.policyUrl || '', 500)) errors.push(`"${entry.id}": terms.notes or terms.policyUrl is required`);
  }
  const captures = Array.isArray(entry.captures) ? entry.captures : [];
  if (entry.autoPoll) {
    if (!captures.length) errors.push(`"${entry.id}": autoPoll requires at least one replayable capture`);
    for (const capture of captures) {
      if (!nonEmpty(capture?.path, 300)) errors.push(`"${entry.id}": capture.path is required`);
      else if (!existsSync(resolve(rootDir, capture.path))) errors.push(`"${entry.id}": capture file missing: ${capture.path}`);
      if (!validDate(capture?.capturedAt || '')) errors.push(`"${entry.id}": capture.capturedAt must be a date`);
      if (!nonEmpty(capture?.provenance, 500)) errors.push(`"${entry.id}": capture.provenance is required`);
      if (!nonEmpty(capture?.parser, 300)) errors.push(`"${entry.id}": capture.parser is required`);
    }
  } else {
    // Proposed entries may list captures, but any listed path must exist.
    for (const capture of captures) {
      if (capture?.path && !existsSync(resolve(rootDir, capture.path))) errors.push(`"${entry.id}": capture file missing: ${capture.path}`);
    }
  }
  return errors;
}

export function validateRegistry(registry, options = {}) {
  if (!registry || typeof registry !== 'object') return ['registry must be an object'];
  if (registry.version !== REGISTRY_VERSION) return [`registry.version must be ${REGISTRY_VERSION}`];
  if (!Array.isArray(registry.sources)) return ['registry.sources must be an array'];
  const errors = [];
  const ids = new Set();
  for (const entry of registry.sources) {
    if (ids.has(entry?.id)) errors.push(`duplicate source id "${entry?.id}"`);
    ids.add(entry?.id);
    errors.push(...validateSource(entry, options));
  }
  return errors;
}

// True only when every gate for automatic collection is satisfied.
export function isApprovedForAuto(entry, { rootDir = process.cwd() } = {}) {
  if (!entry || entry.status !== 'approved' || entry.autoPoll !== true) return false;
  return validateSource(entry, { rootDir }).length === 0;
}

export function approvedAutoSources(registry, options = {}) {
  if (!Array.isArray(registry?.sources)) return [];
  return registry.sources.filter(entry => isApprovedForAuto(entry, options));
}

// Scope a source URL to one registry entry's hosts/handles. Mirrors the
// server's editorial URL rules: exact HTTPS hosts (no ports/auth), and
// X/Twitter URLs only as /<handle>/status/<id> for a listed handle.
export function sourceAllowsUrl(entry, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    const hosts = (entry?.hosts || []).map(h => String(h).toLowerCase());
    if (hosts.includes(host)) return true;
    if (!['x.com', 'twitter.com'].includes(host)) return false;
    const handles = (entry?.handles || []).map(h => String(h).replace(/^@/, '').toLowerCase());
    const [handle, action, postId] = url.pathname.split('/').filter(Boolean);
    return handles.includes(String(handle).toLowerCase()) && action === 'status' && /^\d{8,25}$/.test(String(postId));
  } catch { return false; }
}

export function findSourcesForUrl(registry, raw) {
  if (!Array.isArray(registry?.sources)) return [];
  return registry.sources.filter(entry => entry.status !== 'suspended' && sourceAllowsUrl(entry, raw));
}

export async function loadRegistry(path) {
  const raw = await readFile(path, 'utf8');
  const registry = JSON.parse(raw);
  const errors = validateRegistry(registry, { rootDir: resolve(path, '..', '..') });
  if (errors.length) throw new Error(`Invalid approved-sources registry: ${errors[0]}`);
  return registry;
}
