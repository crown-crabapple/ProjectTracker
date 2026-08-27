/**
 * The forge rules: which work package a repository object belongs to, and what
 * the deck's numbers mean.
 *
 * Named after gitdeck (https://github.com/debba/gitdeck, MIT), which is where
 * the dashboard shape and the health score come from. Gitdeck is a React and
 * TypeScript app over its own on-disk cache; this is its model rewritten in the
 * shape of this codebase — no build step, no second dependency, and the mirror
 * in MariaDB rather than in ~/.gitdeck — so that the tracker's rollup and the
 * repository's state are answered by the same database in the same request. The
 * scoring below is gitdeck's, kept number for number so that a repository reads
 * the same in both, and the places where it had to change are marked.
 *
 * NOTHING IN THIS FILE IS A PROGRESS FIGURE. A health score is a repository's
 * hygiene and a CI success rate is a pipeline's; neither is readiness, neither
 * enters the denominator, and neither may be shown where a percentage from
 * `rollup.js` is shown without saying which is which. That rule is the whole
 * reason this is a separate module: a "78%" beside a "62%" with nothing to say
 * what either one counts is how a portfolio review goes wrong.
 *
 * Everything here is pure. The HTTP client is `src/gitdeck/client.js` and the
 * writer is `src/gitdeck/pull.js`; this file never fetches and never writes.
 */

'use strict';

const DAY_MS = 86400000;

/** The five relations a link can claim, in the order they are worth reading. */
const RELATIONS = ['implements', 'fixes', 'tracks', 'releases', 'mentions'];

/** The item kinds a work package type may be mapped onto. */
const ITEM_KINDS = ['pull_request', 'issue', 'milestone', 'release', 'branch', 'none'];

/**
 * The verbs that turn a reference into a claim.
 *
 * They do two jobs, and both are about the difference between naming work and
 * doing it. In a BODY they are what separates 'blocked on WP-112' from 'closes
 * WP-112' — the first is a mention, the second is the change itself. And
 * anywhere, they are what lets a merge or a close move the work package's
 * status, which is the only thing a verb in somebody's pull request body should
 * be trusted to decide.
 *
 * The list is the forges' own closing keywords plus the three a release note
 * uses, because 'releases M-V1-001' is exactly as much of a claim as 'closes'
 * and a MILESTONE's counterpart is a release.
 */
const CLOSING = /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?|release[sd]?|ship(?:s|ped)?|deliver(?:s|ed)?)\b[\s:]*$/i;

/**
 * A key, as a repository writes it: WP-124, F-LOAD-012, PH-2, B-UI-7.
 *
 * One to four letters, then any number of alphanumeric segments, then digits.
 * The leading segment is checked against the known prefixes afterwards rather
 * than being baked in here, because the prefixes are data — a type's
 * `git_key_prefix` column — and a regex built from a constant would ignore an
 * administrator who changed one.
 */
const KEY_RE = /\b([A-Za-z]{1,4})((?:-[A-Za-z0-9]{1,12})*)-(\d{1,6})\b/g;

/**
 * Pull the candidate keys out of one piece of text.
 *
 * `caseSensitive` is the difference between a title and a branch name, and it is
 * not a preference. In a title or a body a key is written the way the tracker
 * writes it, in capitals, and matching case-insensitively there turns the
 * English sentence "the m-1 connector" into a claim about MILESTONE 1. A branch
 * name is lowercased by half the people who type one — `feature/f-load-012` —
 * so a branch is matched either way. False positives from a branch are cheap:
 * the key has to resolve to a real work package before anything is recorded.
 */
function keysIn(text, { prefixes, matchedIn, caseSensitive = true }) {
  const out = [];
  if (!text) return out;
  const known = new Set(prefixes.map((p) => String(p).toUpperCase()));
  const source = String(text);
  KEY_RE.lastIndex = 0;
  let m = KEY_RE.exec(source);
  while (m) {
    const [whole, head, middle, digits] = m;
    const upper = head.toUpperCase();
    const written = caseSensitive ? head === upper && middle === middle.toUpperCase() : true;
    if (written && known.has(upper)) {
      out.push({
        candidate: `${upper}${middle.toUpperCase()}-${digits}`,
        matchedIn,
        // The words immediately before the key, which is where a closing verb
        // sits. Bounded at 24 characters: a verb further away than that is a
        // sentence about something else.
        closing: CLOSING.test(source.slice(Math.max(0, m.index - 24), m.index)),
        raw: whole,
      });
    }
    m = KEY_RE.exec(source);
  }
  return out;
}

/**
 * Every candidate key on one forge item, deduplicated.
 *
 * A key that appears in the title and again in the branch is one candidate, and
 * it keeps the stronger claim: the title wins for provenance because that is
 * what a person reads, and a closing verb anywhere counts as a closing verb.
 */
function candidateKeys(item, prefixes) {
  const found = [
    ...keysIn(item.title, { prefixes, matchedIn: 'title' }),
    ...keysIn(item.body, { prefixes, matchedIn: 'body' }),
    ...keysIn(item.head_branch, { prefixes, matchedIn: 'branch', caseSensitive: false }),
  ];
  const byKey = new Map();
  for (const hit of found) {
    const existing = byKey.get(hit.candidate);
    if (!existing) { byKey.set(hit.candidate, { ...hit }); continue; }
    existing.closing = existing.closing || hit.closing;
    const rank = { title: 0, body: 1, branch: 2 };
    if (rank[hit.matchedIn] < rank[existing.matchedIn]) existing.matchedIn = hit.matchedIn;
  }
  return [...byKey.values()];
}

/**
 * Resolve one forge item's candidate keys against the work packages that exist.
 *
 * `index` is a Map from an upper-cased key — both `WP-124` and `F-LOAD-012` for
 * the same row — to `{ id, project_id, type_name, rule }`. `rule` is the type's
 * mapping, already merged with any per-repository override by the caller.
 *
 * Returns the links to write and the candidates that resolved to nothing. The
 * second list is not an error and is not discarded: a branch named for a key the
 * tracker has never heard of is the single most useful thing a pull can report,
 * and a count cannot say which key it was.
 */
function matchItem(item, index, { repositoryProjectId = null } = {}) {
  const prefixes = new Set(['WP']);
  for (const entry of index.values()) if (entry.rule && entry.rule.key_prefix) prefixes.add(entry.rule.key_prefix);

  const links = [];
  const unmatched = [];
  for (const hit of candidateKeys(item, [...prefixes])) {
    const wp = index.get(hit.candidate);
    if (!wp) { unmatched.push(hit); continue; }
    // A repository belongs to a project. A key that resolves to a work package
    // in a different project is a coincidence — two projects legitimately share
    // an F-LOAD-012 — and linking across it would put another team's pull
    // request on this team's feature.
    if (repositoryProjectId && Number(wp.project_id) !== Number(repositoryProjectId)) {
      unmatched.push({ ...hit, reason: 'that key belongs to another project' });
      continue;
    }
    const rule = wp.rule || {};
    // Two tests, and a link is a claim only if it passes both.
    //
    //   THE KINDS AGREE. A FEATURE implements a pull request; the same FEATURE
    //   named in a release note is mentioned by it, not implemented by it.
    //   Recording both as 'implements' makes "what implements this" unusable
    //   within a week.
    //
    //   WHERE THE KEY WAS WRITTEN. A key in the title or the branch name is what
    //   the change IS — nobody names a branch after work it merely refers to. A
    //   key in the body is a reference unless a closing verb claims it, because
    //   'blocked on WP-112' and 'closes WP-112' are opposite sentences and the
    //   only difference between them is the verb.
    const kindsAgree = Boolean(rule.item_kind) && rule.item_kind === item.kind;
    const claimed = hit.matchedIn !== 'body' || hit.closing;
    const relation = kindsAgree && claimed ? rule.relation : 'mentions';
    links.push({
      work_package_id: wp.id,
      relation,
      origin: hit.matchedIn === 'branch' ? 'branch' : 'key',
      matched_key: hit.candidate,
      matched_in: hit.matchedIn,
      // Not stored. The pull re-derives it from the title and body it keeps, so
      // a column would be a second copy of a fact that is already on the row.
      closing: hit.closing,
      expected_kind: rule.item_kind || 'none',
    });
  }
  return { links, unmatched };
}

/**
 * The health score, from gitdeck's `buildRepoInsight`.
 *
 * Kept number for number — 78 to start, minus 8 a stale issue to a floor of 24,
 * and the rest — so that a repository scores the same here as it does there.
 * Two things had to change and both are visible in the result rather than
 * hidden:
 *
 *   `basis` names the signals that were actually available. Traffic, downloads
 *   and star history are GitHub REST endpoints that a token without the repo
 *   scope cannot read and that GitLab and Forgejo do not have at all, so a
 *   self-hosted Forgejo repository scores on push recency and issues alone. A
 *   score that silently means something different per forge is worse than a
 *   score that says which half of itself it could not compute.
 *
 *   `securityAlertsUnavailable` is carried through rather than folded into
 *   zero. Nought open alerts and no permission to look are opposite facts, and
 *   this codebase already lost that argument once with `excluded is not zero`.
 */
function healthScore(input) {
  const now = input.now || Date.now();
  const issues = input.issues || [];
  const staleIssueCount = issues.filter((i) => (
    i.updated_at && now - Date.parse(String(i.updated_at).replace(' ', 'T') + 'Z') > 30 * DAY_MS
  )).length;
  const daysSincePush = input.pushed_at
    ? Math.floor((now - Date.parse(String(input.pushed_at).replace(' ', 'T') + 'Z')) / DAY_MS)
    : null;
  const views = Number(input.views_count) || 0;
  const releaseCount = Number(input.release_count) || 0;
  const totalDownloads = Number(input.total_downloads) || 0;
  const recentDownloads = Number(input.recent_downloads) || 0;
  const starsDelta = input.stars_delta === null || input.stars_delta === undefined ? null : Number(input.stars_delta);
  const forksDelta = input.forks_delta === null || input.forks_delta === undefined ? null : Number(input.forks_delta);
  const alertCount = Number(input.security_alerts) || 0;
  const daysSinceRelease = input.latest_release_at
    ? Math.floor((now - Date.parse(String(input.latest_release_at).replace(' ', 'T') + 'Z')) / DAY_MS)
    : null;

  let score = 78;
  score -= Math.min(24, staleIssueCount * 8);
  score -= Math.min(18, issues.length * 3);
  if (daysSincePush !== null && daysSincePush > 14) score -= Math.min(20, Math.floor((daysSincePush - 14) / 7) * 4);
  if (daysSinceRelease !== null && daysSinceRelease > 120 && views > 150) score -= 12;
  if (input.latest_release_at === null && views > 150) score -= 10;
  score -= Math.min(18, alertCount * 3);
  if (daysSincePush !== null && daysSincePush <= 7) score += 10;
  if ((starsDelta || 0) > 0) score += Math.min(8, starsDelta);
  if ((forksDelta || 0) > 0) score += Math.min(4, forksDelta);
  if (recentDownloads > 0) score += Math.min(10, Math.floor(recentDownloads / 25));
  if (views > 0 && totalDownloads > 0) score += Math.min(6, Math.floor((totalDownloads / Math.max(views, 1)) * 10));
  score = Math.max(0, Math.min(100, Math.round(score)));

  const alerts = [];
  if (alertCount > 0) alerts.push(`${alertCount} open security alert${alertCount === 1 ? '' : 's'} need attention.`);
  if (input.security_alerts_unavailable) alerts.push('Security alerts could not be read with this token, so they are not counted.');
  if (staleIssueCount >= 3) alerts.push(`${staleIssueCount} issues have not moved in a month.`);
  if (daysSincePush !== null && daysSincePush > 45 && issues.length > 0) {
    alerts.push(`No push for ${daysSincePush} days while issues remain open.`);
  }

  const basis = [];
  basis.push(daysSincePush === null ? 'no push date' : 'push recency');
  basis.push('open issues');
  basis.push(input.security_alerts_unavailable ? 'security alerts UNAVAILABLE' : 'security alerts');
  if (views > 0) basis.push('traffic');
  if (releaseCount > 0) basis.push('releases');
  if (starsDelta !== null) basis.push('star history');

  return {
    score,
    label: score >= 80 ? 'strong' : score >= 55 ? 'watch' : 'risky',
    stale_issues: staleIssueCount,
    open_issues: issues.length,
    days_since_push: daysSincePush,
    days_since_release: daysSinceRelease,
    security_alerts: alertCount,
    security_alerts_unavailable: Boolean(input.security_alerts_unavailable),
    alerts,
    basis,
  };
}

/**
 * CI over the runs a pull collected, from gitdeck's `ciHealth`.
 *
 * The success rate counts successes and failures only. A cancelled or skipped
 * run is neither, and putting them in the denominator makes a pipeline look
 * worse the more aggressively it cancels superseded runs — the opposite of the
 * truth. Runs still in flight are counted separately and named.
 */
function ciSummary(runs) {
  let success = 0;
  let failure = 0;
  let cancelled = 0;
  let skipped = 0;
  let running = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const run of runs || []) {
    if (run.state !== 'completed') { running += 1; continue; }
    if (run.conclusion === 'success') success += 1;
    else if (['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion)) failure += 1;
    else if (run.conclusion === 'cancelled') cancelled += 1;
    else skipped += 1;
    if (run.duration_sec !== null && run.duration_sec !== undefined) {
      durationSum += Number(run.duration_sec);
      durationCount += 1;
    }
  }
  const scored = success + failure;
  return {
    total: (runs || []).length,
    success,
    failure,
    cancelled,
    skipped,
    running,
    scored,
    // Null, not zero, when nothing has finished. Zero per cent means every run
    // failed, which is a different morning.
    success_pct: scored ? Math.round((success / scored) * 100) : null,
    avg_duration_sec: durationCount ? Math.round(durationSum / durationCount) : null,
    basis: scored
      ? `${scored} completed run${scored === 1 ? '' : 's'}; cancelled and skipped are excluded`
      : 'nothing has finished yet',
  };
}

/**
 * How much of the work is actually connected to the repository, both ways.
 *
 * Two numbers because there are two failures and they are not the same one:
 * work the repository has never heard of (a feature with no pull request), and
 * repository work the tracker has never heard of (a merged pull request that
 * belongs to no work package). A single "coverage" figure hides whichever of
 * the two is currently worse.
 *
 * Only types that map to something are counted. A type whose `git_item_kind` is
 * 'none' is not missing a link; it was never expected to have one, and putting
 * it in the denominator would make the figure improve by deleting phases.
 */
function coverage({ workPackages = [], items = [], links = [] } = {}) {
  const linkedWps = new Set(links.map((l) => Number(l.work_package_id)));
  const linkedItems = new Set(links.map((l) => Number(l.git_item_id)));
  const mappable = workPackages.filter((w) => w.git_item_kind && w.git_item_kind !== 'none');
  const mappedItems = items.filter((i) => ['pull_request', 'issue', 'milestone', 'release'].includes(i.kind));
  const linkedCount = mappable.filter((w) => linkedWps.has(Number(w.id))).length;
  const itemsLinked = mappedItems.filter((i) => linkedItems.has(Number(i.id))).length;
  return {
    mappable: mappable.length,
    linked: linkedCount,
    unlinked: mappable.length - linkedCount,
    pct: mappable.length ? Math.round((linkedCount / mappable.length) * 100) : null,
    items: mappedItems.length,
    items_linked: itemsLinked,
    items_unlinked: mappedItems.length - itemsLinked,
    items_pct: mappedItems.length ? Math.round((itemsLinked / mappedItems.length) * 100) : null,
    excluded_types: workPackages.length - mappable.length,
    basis: 'work packages whose type maps to a forge object; a type mapped to none is excluded, not counted as missing',
  };
}

/**
 * The daily digest, from gitdeck's digest view — counted, not narrated.
 *
 * Gitdeck can hand the same counts to an OpenAI model for a paragraph of prose.
 * That is a second runtime dependency and a third party reading a private
 * repository's titles, so this stops at the counts and the list. Naming it here
 * so nobody looks for the paragraph and concludes it broke.
 */
function digest(items, { since, now = Date.now() } = {}) {
  const from = since ? Date.parse(String(since).replace(' ', 'T') + 'Z') : now - DAY_MS;
  const within = (value) => value && Date.parse(String(value).replace(' ', 'T') + 'Z') >= from;
  const opened = items.filter((i) => within(i.opened_at));
  const merged = items.filter((i) => within(i.merged_at));
  const closed = items.filter((i) => within(i.closed_at) && !i.merged_at);
  return {
    opened: opened.length,
    merged: merged.length,
    closed: closed.length,
    pull_requests_open: items.filter((i) => i.kind === 'pull_request' && i.state === 'open').length,
    issues_open: items.filter((i) => i.kind === 'issue' && i.state === 'open').length,
    highlights: [...merged, ...opened].slice(0, 8).map((i) => ({
      kind: i.kind, ref: i.ref, title: i.title, state: i.state, url: i.url,
    })),
    basis: 'counted from the mirror, not narrated — see the header of src/domain/gitdeck.js',
  };
}

/** A work package's two addresses, upper-cased, for the match index. */
function keysFor(wp) {
  const keys = [];
  if (wp.wp_key) keys.push(String(wp.wp_key).toUpperCase());
  if (wp.ref_key) keys.push(String(wp.ref_key).toUpperCase());
  return keys;
}

/**
 * Is this candidate key well formed? Used to validate a `ref_key` before it is
 * stored, so that a key nothing can ever match is refused at the point somebody
 * types it rather than discovered when no pull request finds it.
 */
function isValidRefKey(value) {
  if (typeof value !== 'string' || !value.length || value.length > 48) return false;
  return /^[A-Za-z]{1,4}(-[A-Za-z0-9]{1,12})*-\d{1,6}$/.test(value);
}

module.exports = {
  RELATIONS, ITEM_KINDS, KEY_RE,
  keysIn, candidateKeys, matchItem,
  healthScore, ciSummary, coverage, digest,
  keysFor, isValidRefKey,
};
