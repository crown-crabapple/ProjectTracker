/**
 * The webhook receiver: the forge telling us, instead of us asking.
 *
 * One route, `POST /api/hooks/git/:id`, reachable with no account — like the
 * email intake and the calendar feed, and for the same reason: the caller is a
 * machine somewhere else that will never hold a session.
 *
 * FIVE RULES, and each is the answer to a question somebody will ask.
 *
 *  1. AN UNSIGNED DELIVERY IS NEVER ACCEPTED. Not accepted-with-a-warning, not
 *     accepted-if-it-parses. The URL is not a secret — it is in a settings page
 *     on the forge and in this app's own UI — so the signature is the only thing
 *     standing between the internet and a work package's status. A repository
 *     with no `hook_secret_env`, or whose variable is unset in this process, is
 *     refused with a message naming the variable.
 *
 *  2. THE SIGNATURE IS CHECKED OVER THE RAW BYTES, BEFORE ANYTHING IS PARSED.
 *     Re-serialising JSON and hashing that is the classic way to get a
 *     signature check that passes for the wrong body.
 *
 *  3. EVERY DELIVERY IS RECORDED, INCLUDING THE REFUSALS, WITH THE REASON.
 *     "The forge says it delivered and the tracker shows nothing" is otherwise
 *     unanswerable. `email_intake` keeps its rejections for the same reason.
 *
 *  4. IT WRITES THROUGH THE SAME PATH A PULL WRITES THROUGH. `src/gitdeck/
 *     mirror.js` matches, mirrors and moves. A receiver with its own writer
 *     would eventually disagree with the puller about what a link means.
 *
 *  5. A DELIVERY BORROWS AN AUTHORITY OR MOVES NOTHING. Nobody starts a webhook,
 *     so a status change needs somebody to be answerable for it:
 *     `repositories.hook_actor_id` names that person, the change can do no more
 *     than they could, and the trail records `gitdeck · webhook` INSTEAD OF
 *     them. With no actor named, the delivery mirrors and links and says in its
 *     own record that a status change was implied and not made — which is a
 *     different fact from nothing having happened.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const notify = require('../domain/notify');
const client = require('./client');
const mirror = require('./mirror');

const ACTOR = 'gitdeck · webhook';
const PAYLOAD_KEPT = 64 * 1024;

/** The header names each forge uses. */
const HEADERS = {
  github: { event: 'x-github-event', delivery: 'x-github-delivery', signature: 'x-hub-signature-256' },
  gitlab: { event: 'x-gitlab-event', delivery: 'x-gitlab-event-uuid', token: 'x-gitlab-token' },
  forgejo: {
    event: 'x-forgejo-event', altEvent: 'x-gitea-event',
    delivery: 'x-forgejo-delivery', altDelivery: 'x-gitea-delivery',
    signature: 'x-forgejo-signature', altSignature: 'x-gitea-signature',
  },
};

const header = (headers, name) => (name && headers[name] ? String(headers[name]) : null);

/** Constant time, and false rather than a throw when the lengths differ. */
function sameSecret(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const hmac = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

/**
 * Check the delivery is from who it says.
 *
 * GitHub and Forgejo sign the body; GitLab sends the secret back verbatim, which
 * is weaker and is GitLab's decision rather than this app's — it is still only
 * accepted over the secret the repository names, and the comparison is constant
 * time either way.
 */
function verify(scm, headers, raw, secret) {
  if (scm === 'gitlab') {
    const sent = header(headers, HEADERS.gitlab.token);
    if (!sent) return { ok: false, reason: 'no X-Gitlab-Token on the delivery' };
    return sameSecret(sent, secret)
      ? { ok: true }
      : { ok: false, reason: 'X-Gitlab-Token did not match the secret this repository names' };
  }
  const names = scm === 'github' ? HEADERS.github : HEADERS.forgejo;
  const sent = header(headers, names.signature)
    || header(headers, names.altSignature)
    // Forgejo and Gitea also send GitHub's header, and a forge configured
    // "GitHub-compatible" sends only that one.
    || header(headers, HEADERS.github.signature);
  if (!sent) return { ok: false, reason: 'the delivery carried no signature header' };
  const expected = hmac(secret, raw);
  // GitHub prefixes 'sha256='; Forgejo sends the bare hex.
  const offered = sent.startsWith('sha256=') ? sent.slice(7) : sent;
  return sameSecret(offered.toLowerCase(), expected)
    ? { ok: true }
    : { ok: false, reason: 'the signature did not match the secret this repository names' };
}

/**
 * The JSON body, whichever way the forge was configured to send it.
 *
 * GitHub's "application/x-www-form-urlencoded" option sends `payload=<json>`.
 * The signature is over the form body either way, which is why this happens
 * after verification and not before.
 */
function parseBody(contentType, raw) {
  const text = raw.toString('utf8');
  if (String(contentType || '').includes('application/x-www-form-urlencoded')) {
    const value = new URLSearchParams(text).get('payload');
    if (!value) throw new Error('a form-encoded delivery with no payload field');
    return JSON.parse(value);
  }
  return JSON.parse(text);
}

/**
 * One delivery, as items and commits this app already knows how to write.
 *
 * Every branch here hands the payload's object to the SAME normaliser a pull
 * uses on a fetched one, so a pull request that arrives by webhook and the same
 * pull request fetched an hour later produce the same row.
 *
 * An event this does not know is not an error: forges send more than anybody
 * subscribes to, and a receiver that 400s on `star` teaches whoever set it up to
 * narrow the subscription until something useful is missing too. It is recorded
 * as ignored, with the event named.
 */
function itemsFrom(scm, event, payload) {
  const N = client.NORMALISERS[scm];
  const one = (fn, value) => (value ? fn([value]) : []);
  const commitsFrom = (rows, branch) => (rows || []).map((c) => ({
    identifier: String(c.id || c.sha || '').slice(0, 40),
    author: c.author ? (c.author.name || c.author.username || c.author.login || null) : null,
    message: client.text(c.message || c.title, 2000),
    committed_at: client.stamp(c.timestamp || c.committed_date || c.created_at),
    url: c.url || c.html_url || null,
    branch,
  })).filter((c) => c.identifier);

  // 'refs/heads/x' -> 'x'. A tag or a deleted branch yields null and is not
  // mirrored as a branch.
  const branchOf = (ref) => {
    const m = /^refs\/heads\/(.+)$/.exec(String(ref || ''));
    return m ? m[1] : null;
  };

  if (scm === 'gitlab') {
    const kind = payload.object_kind || event;
    const oa = payload.object_attributes || {};
    // A hook's object_attributes is the REST object with two names changed, so
    // it is adapted rather than normalised a second way.
    const asRest = { ...oa, web_url: oa.url || oa.web_url, author: payload.user, labels: payload.labels };
    if (kind === 'merge_request') return { items: one(N.pulls, asRest), commits: [] };
    if (kind === 'issue') return { items: one(N.issues, asRest), commits: [] };
    if (kind === 'pipeline') return { items: one(N.runs, asRest), commits: [] };
    if (kind === 'release') {
      return {
        items: one(N.releases, {
          tag_name: payload.tag, name: payload.name, description: payload.description,
          created_at: payload.created_at, released_at: payload.released_at, _links: payload._links,
        }),
        commits: [],
      };
    }
    if (kind === 'push' || kind === 'tag_push') {
      const branch = branchOf(payload.ref);
      return {
        items: branch ? [{ kind: 'branch', ref: branch, title: branch, state: 'open', head_branch: branch }] : [],
        commits: commitsFrom(payload.commits, branch),
      };
    }
    return { items: [], commits: [], unknown: kind };
  }

  // GitHub and Forgejo speak the same event names and nearly the same payloads.
  switch (event) {
    case 'ping':
      return { items: [], commits: [], ping: true };
    case 'pull_request':
    case 'pull_request_review':
    case 'pull_request_review_comment':
      return { items: one(N.pulls, payload.pull_request), commits: [] };
    case 'issues':
      return { items: one(N.issues, payload.issue), commits: [] };
    case 'issue_comment':
      // The issue, not the comment: a comment changes the issue's updated_at and
      // its comment count, and both are things the deck shows. A comment body
      // naming a key links the issue, which is what somebody writing 'fixes
      // F-LOAD-012' in a comment expects.
      return { items: payload.issue && !payload.issue.pull_request ? N.issues([payload.issue]) : [], commits: [] };
    case 'milestone':
      return { items: one(N.milestones, payload.milestone), commits: [] };
    case 'release':
      return { items: one(N.releases, payload.release), commits: [] };
    case 'workflow_run':
      return { items: N.runs ? one(N.runs, payload.workflow_run) : [], commits: [] };
    case 'push': {
      const branch = branchOf(payload.ref);
      return {
        // A branch is mirrored on the push that creates it, which is what makes
        // `feature/f-load-012-decisions` link to its feature the moment it is
        // pushed rather than at the next pull.
        items: branch && !payload.deleted
          ? [{ kind: 'branch', ref: branch, title: branch, state: 'open', head_branch: branch }]
          : [],
        commits: commitsFrom(payload.commits, branch),
      };
    }
    case 'create':
      return {
        items: payload.ref_type === 'branch'
          ? [{ kind: 'branch', ref: payload.ref, title: payload.ref, state: 'open', head_branch: payload.ref }]
          : [],
        commits: [],
      };
    default:
      return { items: [], commits: [], unknown: event };
  }
}

/**
 * Receive one delivery.
 *
 * Returns `{ status, body }` rather than throwing, because every outcome — the
 * refusals included — has a row to write first and a body a forge's delivery log
 * should show. The one exception is a repository that does not exist, which is a
 * 404 with a row of its own.
 */
async function receive({ repositoryId, headers = {}, raw = Buffer.alloc(0), remoteAddr = null, problem = null }) {
  const record = {
    repository_id: null,
    delivery_id: null,
    event: null,
    action: null,
    state: 'rejected',
    reason: null,
    signature_ok: 0,
    items_touched: 0,
    links_made: 0,
    statuses_moved: 0,
    payload: raw.length ? raw.slice(0, PAYLOAD_KEPT).toString('utf8') : null,
    payload_bytes: raw.length,
    remote_addr: remoteAddr ? String(remoteAddr).slice(0, 64) : null,
  };

  const repo = await db.one(`
    SELECT r.*, p.code AS project_code FROM repositories r
      JOIN projects p ON p.id = r.project_id WHERE r.id = ?`, [repositoryId]);
  if (!repo) {
    record.reason = `no repository ${repositoryId}`;
    await db.insert('git_hook_deliveries', record);
    return { status: 404, body: { error: 'no such repository' } };
  }
  record.repository_id = repo.id;

  const names = HEADERS[repo.scm] || HEADERS.github;
  record.event = header(headers, names.event) || header(headers, names.altEvent) || null;
  record.delivery_id = header(headers, names.delivery) || header(headers, names.altDelivery) || null;

  const finish = async (status, body) => {
    await db.insert('git_hook_deliveries', record);
    await db.run(
      'UPDATE repositories SET hook_state = ?, hook_detail = ?, hook_last_at = NOW() WHERE id = ?',
      [record.state === 'rejected' ? 'rejected' : 'ok', (record.reason || '').slice(0, 300) || null, repo.id]
    );
    return { status, body };
  };

  // The body never arrived in full — too large, or the connection died. Recorded
  // against the repository rather than lost, because "the forge says it
  // delivered" needs an answer even when nothing was read.
  if (problem) {
    record.reason = problem;
    return finish(400, { error: problem });
  }

  if (!client.PROVIDERS[repo.scm]) {
    record.reason = `${repo.scm} has no webhook format this receiver understands`;
    return finish(400, { error: record.reason });
  }

  // --- rule 1 and rule 2: signed, over the raw bytes, or refused.
  if (!repo.hook_secret_env) {
    record.reason = 'this repository records no hook_secret_env, so a delivery cannot be verified — '
      + 'an unsigned delivery is never accepted';
    return finish(401, { error: record.reason });
  }
  const secret = process.env[repo.hook_secret_env];
  if (!secret) {
    record.reason = `${repo.hook_secret_env} is not set in this process, so the signature cannot be checked`;
    return finish(401, { error: record.reason });
  }
  const verified = verify(repo.scm, headers, raw, secret);
  if (!verified.ok) {
    record.reason = verified.reason;
    return finish(401, { error: verified.reason });
  }
  record.signature_ok = 1;

  let payload;
  try {
    payload = parseBody(headers['content-type'], raw);
  } catch (e) {
    record.reason = `the body is not something this receiver can read: ${e.message}`;
    return finish(400, { error: record.reason });
  }
  record.action = payload && payload.action ? String(payload.action).slice(0, 60) : null;
  if (!record.event) record.event = payload && payload.object_kind ? String(payload.object_kind) : null;

  // --- a retry is a fact; the second row says it was ignored.
  if (record.delivery_id) {
    const seen = await db.one(
      "SELECT id FROM git_hook_deliveries WHERE repository_id = ? AND delivery_id = ? AND state = 'applied'",
      [repo.id, record.delivery_id]
    );
    if (seen) {
      record.state = 'ignored';
      record.reason = `this delivery was already applied (${record.delivery_id})`;
      return finish(200, { ok: true, state: 'ignored', reason: record.reason });
    }
  }

  const mapped = itemsFrom(repo.scm, record.event, payload);
  if (mapped.ping) {
    record.state = 'ignored';
    record.reason = 'ping — the hook is configured correctly';
    return finish(200, { ok: true, state: 'ignored', reason: record.reason });
  }
  if (!mapped.items.length && !mapped.commits.length) {
    record.state = 'ignored';
    record.reason = mapped.unknown
      ? `nothing to mirror from a "${mapped.unknown}" event`
      : `a ${record.event || 'nameless'} event carried nothing this tracker mirrors`;
    return finish(200, { ok: true, state: 'ignored', reason: record.reason });
  }

  // --- rule 4: the same write path a pull uses.
  const { index, byId } = await mirror.contextFor(repo);
  const { matched, commitLinks, unmatched } = mirror.match({
    repo, index, items: mapped.items, commits: mapped.commits,
  });

  const written = await db.transaction(async (tx) => {
    const out = await mirror.write(tx, { repo, matched, commitLinks, unmatched, byId, actorLabel: ACTOR });
    // The activity trail gets an entry only when something actually changed. A
    // busy repository delivers all day; a trail that is never capped is a trail
    // that must not be filled with "heard about a pull request, again". The
    // delivery row above is the record that it arrived.
    if (out.counts.items_new || out.counts.links_made || out.counts.commit_links) {
      await notify.record({
        projectId: repo.project_id, actorLabel: ACTOR,
        kind: 'repo', verb: 'heard from the repository', targetLabel: repo.name,
        detail: `${record.event}${record.action ? ` ${record.action}` : ''} — `
          + `${out.counts.items_new} new, ${out.counts.links_made} link(s) made`,
      }, tx);
    }
    return out;
  });

  record.items_touched = matched.length;
  record.links_made = written.counts.links_made;

  // --- rule 5: borrow an authority, or move nothing and say so.
  const actor = repo.hook_actor_id
    ? await db.one(
      'SELECT id, login, name, is_admin, kind, active FROM users WHERE id = ? AND active = 1',
      [repo.hook_actor_id]
    )
    : null;
  const moved = await mirror.applyMoves(written.pending, {
    actor: actor ? { ...actor, is_admin: Boolean(actor.is_admin) } : null,
    actorLabel: ACTOR,
  });
  record.statuses_moved = moved.applied.length;

  record.state = 'applied';
  const notes = [
    `${written.counts.items_new} new`,
    `${written.counts.links_made} link(s)`,
    written.counts.links_held ? `${written.counts.links_held} held back (removed by hand)` : null,
    written.counts.commit_links ? `${written.counts.commit_links} commit link(s)` : null,
    unmatched.length ? `${unmatched.length} key(s) matched nothing` : null,
    moved.applied.length ? `${moved.applied.length} status(es) moved` : null,
    ...moved.problems,
  ].filter(Boolean);
  record.reason = notes.join(', ').slice(0, 400);

  return finish(200, {
    ok: true,
    state: 'applied',
    event: record.event,
    action: record.action,
    items: matched.map((m) => `${m.item.kind} ${m.item.ref}`),
    links_made: written.counts.links_made,
    links_held: written.counts.links_held,
    unmatched: mirror.summariseUnmatched(unmatched).map((u) => u.candidate),
    moves: moved.applied,
    problems: moved.problems,
  });
}

module.exports = { receive, verify, itemsFrom, parseBody, HEADERS, ACTOR };
