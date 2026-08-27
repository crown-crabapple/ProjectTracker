/**
 * The forge client: the one place in this app that makes an outbound request.
 *
 * Until now nothing here polled anything — `docs/features.md` said so in as many
 * words, and the repositories page was a display over rows somebody inserted.
 * This is the half that was missing, ported from gitdeck
 * (https://github.com/debba/gitdeck, MIT) and reduced to what the tracker needs:
 * three forges, seven endpoints each, one normalised item shape out of the far
 * end.
 *
 * WHAT IS DIFFERENT FROM GITDECK, AND WHY
 *
 *   No token store. Gitdeck keeps OAuth device-flow tokens under ~/.gitdeck and
 *   proxies the browser through its own server so the token never reaches the
 *   page. This app has a stricter rule and keeps it: a repository row records the
 *   NAME of an environment variable, the token is read from `process.env` at the
 *   moment of the call, and there is nowhere in the schema it could be written
 *   to even by accident. A database dump carries no secret. The cost is that
 *   device flow cannot work — a flow whose whole purpose is to obtain and store
 *   a token has nothing to store it in — so a personal access token in the
 *   environment is the only way in, and the connections page says so.
 *
 *   No disk cache. Gitdeck caches responses under ~/.gitdeck because its React
 *   front end asks the same question on every navigation. Here the mirror in
 *   MariaDB IS the cache: every screen reads `git_items`, and the network is
 *   touched only by an explicit pull. A second cache in front of that would be a
 *   second answer to "what is the state of PR 978".
 *
 *   No GraphQL. Gitdeck uses GitHub's GraphQL API for the repository grid
 *   because it fetches forty repositories at once. A pull here is one
 *   repository, REST answers it in seven requests, and GraphQL would be a query
 *   language to maintain for two of the three forges.
 *
 * `fetchImpl` is injectable so the selftest can exercise every path — pagination,
 * a 401, a rate limit, a malformed body — against a stub rather than the
 * network. The suite runs against a throwaway database and it must not reach the
 * internet either.
 */

'use strict';

/** An error that names the forge, the status and what was being asked for. */
class ForgeError extends Error {
  constructor(message, { status = null, needsAuth = false, rateLimited = false } = {}) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
    this.needsAuth = needsAuth;
    this.rateLimited = rateLimited;
  }
}

const PROVIDERS = {
  github: {
    apiBase: 'https://api.github.com',
    authHeader: (token) => ({ Authorization: `Bearer ${token}` }),
    accept: 'application/vnd.github+json',
    extraHeaders: { 'X-GitHub-Api-Version': '2022-11-28' },
  },
  gitlab: {
    apiBase: 'https://gitlab.com/api/v4',
    // GitLab's own header. A Bearer token also works for OAuth tokens, but a
    // personal access token — which is what this app can use — is refused as a
    // Bearer, and the resulting 401 says nothing about why.
    authHeader: (token) => ({ 'PRIVATE-TOKEN': token }),
    accept: 'application/json',
    extraHeaders: {},
  },
  forgejo: {
    // No public default: Forgejo is self-hosted, Codeberg is one host among
    // many, and guessing one would send somebody's token to a server they did
    // not name. `api_base` is required for this scm and the error says so.
    apiBase: null,
    authHeader: (token) => ({ Authorization: `token ${token}` }),
    accept: 'application/json',
    extraHeaders: {},
  },
};

const USER_AGENT = 'ProjectTracker-gitdeck';

/** `https://github.com/seedfall/seedfall.git` -> `seedfall/seedfall`. */
function slugFromUrl(url) {
  if (!url) return null;
  const cleaned = String(url).replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:https?:\/\/|git@)[^/:]+[/:](.+)$/.exec(cleaned);
  if (!m) return null;
  const path = m[1].replace(/^\/+/, '');
  return path.includes('/') ? path : null;
}

/** ISO or forge timestamp -> 'YYYY-MM-DD HH:MM:SS' in UTC, or null. */
function stamp(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

const text = (value, max) => {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * One repository's connection: where it is, what speaks there, and which
 * environment variable holds the token.
 */
function connectionFor(repository) {
  const scm = String(repository.scm || '');
  const provider = PROVIDERS[scm];
  if (!provider) {
    throw new ForgeError(
      `"${scm}" has no API client — a pull needs github, gitlab or forgejo. `
      + 'A plain git or svn repository is recorded here and read by whoever clones it.'
    );
  }
  const apiBase = (repository.api_base || provider.apiBase || '').replace(/\/+$/, '');
  if (!apiBase) {
    throw new ForgeError(
      `${repository.name} is a forgejo repository with no api_base, so there is no host to call. `
      + 'Set api_base to the forge root, e.g. https://codeberg.org/api/v1.'
    );
  }
  const slug = repository.slug || slugFromUrl(repository.url);
  if (!slug) {
    throw new ForgeError(
      `${repository.name} has no owner/name to call the API with. Set slug on the repository row.`
    );
  }
  const tokenEnv = repository.token_env || null;
  const token = tokenEnv ? process.env[tokenEnv] || null : null;
  return { scm, provider, apiBase, slug, tokenEnv, token };
}

// ---------------------------------------------------------------- normalising
//
// One shape out of three forges, at module scope because the webhook receiver
// needs exactly these functions: a delivery carries one pull request, one issue
// or one release, and normalising it a second way in `hooks.js` would be a
// second answer to "what state is this in".

const githubItems = {
  pulls: (rows) => rows.map((r) => ({
    kind: 'pull_request',
    ref: String(r.number),
    title: text(r.title, 500),
    state: r.merged_at ? 'merged' : r.draft && r.state === 'open' ? 'draft' : r.state,
    author: r.user ? r.user.login : null,
    head_branch: r.head ? r.head.ref : null,
    base_branch: r.base ? r.base.ref : null,
    url: r.html_url,
    body: text(r.body, 20000),
    labels: text((r.labels || []).map((l) => l.name).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    merged_at: stamp(r.merged_at),
    additions: r.additions === undefined ? null : r.additions,
    deletions: r.deletions === undefined ? null : r.deletions,
    comment_count: r.comments === undefined ? null : r.comments,
  })),
  // GitHub returns pull requests from the issues endpoint too. Keeping them
  // would mirror every pull request twice under two kinds, and the second copy
  // would be the one with no branch.
  issues: (rows) => rows.filter((r) => !r.pull_request).map((r) => ({
    kind: 'issue',
    ref: String(r.number),
    title: text(r.title, 500),
    state: r.state,
    author: r.user ? r.user.login : null,
    url: r.html_url,
    body: text(r.body, 20000),
    labels: text((r.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    comment_count: r.comments === undefined ? null : r.comments,
  })),
  milestones: (rows) => rows.map((r) => ({
    kind: 'milestone',
    ref: String(r.number),
    title: text(r.title, 500),
    state: r.state,
    url: r.html_url,
    body: text(r.description, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
  })),
  releases: (rows) => rows.map((r) => ({
    kind: 'release',
    ref: String(r.tag_name || r.name),
    title: text(r.name || r.tag_name, 500),
    state: r.draft ? 'draft' : r.prerelease ? 'prerelease' : 'published',
    author: r.author ? r.author.login : null,
    url: r.html_url,
    body: text(r.body, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.published_at || r.created_at),
  })),
  branches: (rows) => rows.map((r) => ({
    kind: 'branch',
    ref: String(r.name),
    title: text(r.name, 500),
    state: r.protected ? 'protected' : 'open',
    head_branch: String(r.name),
    url: null,
  })),
  runs: (rows) => rows.map((r) => ({
    kind: 'workflow_run',
    ref: String(r.id),
    title: text(r.name || r.display_title || 'workflow', 500),
    state: r.status,
    conclusion: r.conclusion,
    author: r.actor ? r.actor.login : null,
    head_branch: r.head_branch,
    url: r.html_url,
    opened_at: stamp(r.run_started_at || r.created_at),
    updated_at: stamp(r.updated_at),
    duration_sec: r.updated_at && (r.run_started_at || r.created_at)
      ? Math.max(0, Math.round((Date.parse(r.updated_at) - Date.parse(r.run_started_at || r.created_at)) / 1000))
      : null,
  })),
  alerts: (rows) => rows.map((r) => ({
    kind: 'security_alert',
    ref: String(r.number),
    title: text(
      r.security_advisory ? r.security_advisory.summary
        : r.rule ? r.rule.description : 'security alert', 500
    ),
    state: r.state,
    severity: r.security_advisory ? r.security_advisory.severity
      : r.rule ? r.rule.security_severity_level || r.rule.severity : null,
    url: r.html_url,
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
  })),
};

const gitlabItems = {
  pulls: (rows) => rows.map((r) => ({
    kind: 'pull_request',
    ref: String(r.iid),
    title: text(r.title, 500),
    state: r.state === 'opened' ? (r.draft || r.work_in_progress ? 'draft' : 'open')
      : r.state === 'merged' ? 'merged' : r.state,
    author: r.author ? r.author.username : null,
    head_branch: r.source_branch,
    base_branch: r.target_branch,
    url: r.web_url,
    body: text(r.description, 20000),
    labels: text((r.labels || []).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    merged_at: stamp(r.merged_at),
    comment_count: r.user_notes_count === undefined ? null : r.user_notes_count,
  })),
  issues: (rows) => rows.map((r) => ({
    kind: 'issue',
    ref: String(r.iid),
    title: text(r.title, 500),
    state: r.state === 'opened' ? 'open' : r.state,
    author: r.author ? r.author.username : null,
    url: r.web_url,
    body: text(r.description, 20000),
    labels: text((r.labels || []).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    comment_count: r.user_notes_count === undefined ? null : r.user_notes_count,
  })),
  milestones: (rows) => rows.map((r) => ({
    kind: 'milestone',
    ref: String(r.iid || r.id),
    title: text(r.title, 500),
    state: r.state === 'active' ? 'open' : 'closed',
    url: r.web_url,
    body: text(r.description, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
  })),
  releases: (rows) => rows.map((r) => ({
    kind: 'release',
    ref: String(r.tag_name || r.name),
    title: text(r.name || r.tag_name, 500),
    state: r.upcoming_release ? 'draft' : 'published',
    author: r.author ? r.author.username : null,
    url: r._links ? r._links.self : null,
    body: text(r.description, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.released_at || r.created_at),
  })),
  branches: (rows) => rows.map((r) => ({
    kind: 'branch',
    ref: String(r.name),
    title: text(r.name, 500),
    state: r.protected ? 'protected' : 'open',
    head_branch: String(r.name),
    url: r.web_url || null,
  })),
  runs: (rows) => rows.map((r) => ({
    kind: 'workflow_run',
    ref: String(r.id),
    title: text(r.name || r.ref || 'pipeline', 500),
    // GitLab's pipeline states are its own words. They are mapped to the two
    // this app's CI summary understands — completed or not — and the original
    // is kept in `conclusion`, because 'manual' and 'skipped' are not failures
    // and a mapping that lost them would report a healthy pipeline as red.
    state: ['success', 'failed', 'canceled', 'skipped'].includes(r.status) ? 'completed' : r.status,
    conclusion: r.status === 'failed' ? 'failure' : r.status === 'canceled' ? 'cancelled' : r.status,
    head_branch: r.ref,
    url: r.web_url,
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
  })),
};

const forgejoItems = {
  pulls: (rows) => rows.map((r) => ({
    kind: 'pull_request',
    ref: String(r.number),
    title: text(r.title, 500),
    state: r.merged ? 'merged' : r.state,
    author: r.user ? r.user.login : null,
    head_branch: r.head ? r.head.ref : null,
    base_branch: r.base ? r.base.ref : null,
    url: r.html_url,
    body: text(r.body, 20000),
    labels: text((r.labels || []).map((l) => l.name).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    merged_at: stamp(r.merged_at),
    comment_count: r.comments === undefined ? null : r.comments,
  })),
  issues: (rows) => rows.filter((r) => !r.pull_request).map((r) => ({
    kind: 'issue',
    ref: String(r.number),
    title: text(r.title, 500),
    state: r.state,
    author: r.user ? r.user.login : null,
    url: r.html_url,
    body: text(r.body, 20000),
    labels: text((r.labels || []).map((l) => l.name).join(', '), 500),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
    comment_count: r.comments === undefined ? null : r.comments,
  })),
  milestones: (rows) => rows.map((r) => ({
    kind: 'milestone',
    ref: String(r.id),
    title: text(r.title, 500),
    state: r.state,
    body: text(r.description, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.updated_at),
    closed_at: stamp(r.closed_at),
  })),
  releases: (rows) => rows.map((r) => ({
    kind: 'release',
    ref: String(r.tag_name || r.name),
    title: text(r.name || r.tag_name, 500),
    state: r.draft ? 'draft' : r.prerelease ? 'prerelease' : 'published',
    author: r.author ? r.author.login : null,
    url: r.html_url,
    body: text(r.body, 20000),
    opened_at: stamp(r.created_at),
    updated_at: stamp(r.published_at || r.created_at),
  })),
  branches: (rows) => rows.map((r) => ({
    kind: 'branch',
    ref: String(r.name),
    title: text(r.name, 500),
    state: r.protected ? 'protected' : 'open',
    head_branch: String(r.name),
    url: null,
  })),
};

/**
 * Create a client. `fetchImpl` defaults to the platform fetch, which is the
 * whole reason there is no HTTP dependency in package.json.
 */
function create({ fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ForgeError('no fetch available — Node 18 or later, or pass fetchImpl');
  }

  /** One request. Returns { data, headers, status }. Throws a named ForgeError. */
  async function request(conn, path, { method = 'GET' } = {}) {
    const url = path.startsWith('http') ? path : `${conn.apiBase}${path}`;
    const headers = {
      Accept: conn.provider.accept,
      'User-Agent': USER_AGENT,
      ...conn.provider.extraHeaders,
      ...(conn.token ? conn.provider.authHeader(conn.token) : {}),
    };
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let response;
    try {
      response = await fetchImpl(url, { method, headers, signal: controller ? controller.signal : undefined });
    } catch (e) {
      throw new ForgeError(`${conn.scm} did not answer: ${e.message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const remaining = response.headers && response.headers.get
      ? response.headers.get('x-ratelimit-remaining') : null;

    if (response.status === 401 || response.status === 403) {
      // 403 with the budget at zero is a rate limit, not a permission problem,
      // and telling somebody to check their token when the answer is "wait
      // eleven minutes" costs an afternoon.
      const rateLimited = remaining !== null && Number(remaining) === 0;
      throw new ForgeError(
        rateLimited
          ? `${conn.scm} rate limit reached for this token — nothing was pulled`
          : `${conn.scm} refused the request (${response.status})`
          + (conn.tokenEnv
            ? conn.token ? `; the token in ${conn.tokenEnv} may lack access to ${conn.slug}`
              : `; ${conn.tokenEnv} is not set in this process`
            : '; this repository records no token_env, so the call was anonymous'),
        { status: response.status, needsAuth: !rateLimited, rateLimited }
      );
    }
    if (response.status === 404) {
      throw new ForgeError(`${conn.scm} has no ${conn.slug}, or this token cannot see it`, { status: 404 });
    }
    if (!response.ok) {
      throw new ForgeError(`${conn.scm} answered ${response.status} for ${path}`, { status: response.status });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      throw new ForgeError(`${conn.scm} answered ${path} with something that is not JSON`, { status: response.status });
    }
    return { data, status: response.status, remaining: remaining === null ? null : Number(remaining), response };
  }

  /**
   * Follow pagination up to `pages` pages.
   *
   * Bounded on purpose. A repository with nine thousand closed issues would
   * otherwise turn one pull into ninety requests and exhaust the hourly budget
   * for everything else; the pull reports that it stopped rather than implying
   * it saw everything.
   */
  async function paginate(conn, path, { pages = 3 } = {}) {
    const out = [];
    let next = path;
    let remaining = null;
    let truncated = false;
    for (let i = 0; i < pages && next; i += 1) {
      const res = await request(conn, next);
      remaining = res.remaining === null ? remaining : res.remaining;
      const rows = Array.isArray(res.data) ? res.data : [];
      out.push(...rows);
      next = nextLink(conn, res, next);
      if (next && i === pages - 1) truncated = true;
    }
    return { rows: out, remaining, truncated };
  }

  /** The next page's URL, from the Link header or GitLab's own header. */
  function nextLink(conn, res, current) {
    const headers = res.response && res.response.headers;
    if (!headers || !headers.get) return null;
    const link = headers.get('link');
    if (link) {
      const m = /<([^>]+)>;\s*rel="next"/.exec(link);
      if (m) return m[1];
    }
    const nextPage = headers.get('x-next-page');
    if (nextPage) {
      const sep = current.includes('?') ? '&' : '?';
      return `${current.replace(/([?&])page=\d+/, '$1page=' + nextPage)}${
        /[?&]page=/.test(current) ? '' : `${sep}page=${nextPage}`}`;
    }
    return null;
  }

  /**
   * Everything one pull needs, normalised.
   *
   * `pages` and the per-endpoint limits are deliberately small. This is a
   * mirror of what is happening now, not an archive: a pull that walked six
   * years of closed issues would take the hourly budget and fill a table with
   * rows nothing reads.
   */
  async function fetchRepository(repository, { pages = 2, includeCommits = true } = {}) {
    const conn = connectionFor(repository);
    const items = [];
    const problems = [];
    let remaining = null;
    let truncated = false;

    const collect = async (label, path, mapper, { optional = false } = {}) => {
      try {
        const res = await paginate(conn, path, { pages });
        remaining = res.remaining === null ? remaining : res.remaining;
        truncated = truncated || res.truncated;
        items.push(...mapper(res.rows));
      } catch (e) {
        // An optional endpoint is one a token can legitimately be refused —
        // security alerts need a scope most tokens do not carry. It is reported
        // as a problem and does not fail the pull, because a pull that refused
        // to mirror thirty pull requests over one forbidden endpoint would be a
        // pull nobody runs.
        if (!optional) throw e;
        problems.push(`${label}: ${e.message}`);
      }
    };

    const slug = encodeURIComponent(conn.slug).replace(/%2F/g, '/');
    if (conn.scm === 'github') {
      await collect('pulls', `/repos/${slug}/pulls?state=all&sort=updated&direction=desc&per_page=50`, githubItems.pulls);
      await collect('issues', `/repos/${slug}/issues?state=all&sort=updated&direction=desc&per_page=50`, githubItems.issues);
      await collect('milestones', `/repos/${slug}/milestones?state=all&per_page=50`, githubItems.milestones);
      await collect('releases', `/repos/${slug}/releases?per_page=30`, githubItems.releases);
      await collect('branches', `/repos/${slug}/branches?per_page=50`, githubItems.branches);
      await collect('workflow runs', `/repos/${slug}/actions/runs?per_page=30`,
        (rows) => githubItems.runs(rows && rows.workflow_runs ? rows.workflow_runs : []), { optional: true });
      await collect('dependabot alerts', `/repos/${slug}/dependabot/alerts?state=open&per_page=50`,
        githubItems.alerts, { optional: true });
    } else if (conn.scm === 'gitlab') {
      const id = encodeURIComponent(conn.slug);
      await collect('merge requests', `/projects/${id}/merge_requests?scope=all&state=all&order_by=updated_at&per_page=50`, gitlabItems.pulls);
      await collect('issues', `/projects/${id}/issues?scope=all&order_by=updated_at&per_page=50`, gitlabItems.issues);
      await collect('milestones', `/projects/${id}/milestones?per_page=50`, gitlabItems.milestones);
      await collect('releases', `/projects/${id}/releases?per_page=30`, gitlabItems.releases);
      await collect('branches', `/projects/${id}/repository/branches?per_page=50`, gitlabItems.branches);
      await collect('pipelines', `/projects/${id}/pipelines?per_page=30`, gitlabItems.runs, { optional: true });
    } else {
      await collect('pulls', `/repos/${slug}/pulls?state=all&limit=50`, forgejoItems.pulls);
      await collect('issues', `/repos/${slug}/issues?state=all&type=issues&limit=50`, forgejoItems.issues);
      await collect('milestones', `/repos/${slug}/milestones?state=all&limit=50`, forgejoItems.milestones);
      await collect('releases', `/repos/${slug}/releases?limit=30`, forgejoItems.releases);
      await collect('branches', `/repos/${slug}/branches?limit=50`, forgejoItems.branches);
    }

    // Commits go to `repository_revisions`, which already holds them and already
    // links them to work packages. See the header of db/migrations/0002.
    let commits = [];
    if (includeCommits) {
      const path = conn.scm === 'gitlab'
        ? `/projects/${encodeURIComponent(conn.slug)}/repository/commits?per_page=30`
        : `/repos/${slug}/commits?per_page=30`;
      try {
        const res = await paginate(conn, path, { pages: 1 });
        remaining = res.remaining === null ? remaining : res.remaining;
        commits = res.rows.map((r) => (conn.scm === 'gitlab' ? {
          identifier: String(r.short_id || r.id).slice(0, 40),
          author: r.author_name,
          message: text(r.title || r.message, 2000),
          committed_at: stamp(r.committed_date || r.created_at),
          url: r.web_url,
        } : {
          identifier: String(r.sha).slice(0, 40),
          author: r.commit && r.commit.author ? r.commit.author.name : (r.author ? r.author.login : null),
          message: text(r.commit ? r.commit.message : null, 2000),
          committed_at: stamp(r.commit && r.commit.author ? r.commit.author.date : null),
          url: r.html_url,
        }));
      } catch (e) {
        problems.push(`commits: ${e.message}`);
      }
    }

    return { conn, items, commits, problems, remaining, truncated };
  }

  /** A cheap "does this connection work at all" call, for the connections page. */
  async function checkRepository(repository) {
    const conn = connectionFor(repository);
    const path = conn.scm === 'gitlab'
      ? `/projects/${encodeURIComponent(conn.slug)}`
      : `/repos/${encodeURIComponent(conn.slug).replace(/%2F/g, '/')}`;
    const res = await request(conn, path);
    const data = res.data || {};
    return {
      slug: conn.slug,
      default_branch: data.default_branch || null,
      pushed_at: stamp(data.pushed_at || data.last_activity_at || data.updated_at),
      open_issues: data.open_issues_count === undefined ? null : data.open_issues_count,
      stars: data.stargazers_count === undefined ? data.star_count : data.stargazers_count,
      forks: data.forks_count === undefined ? data.forks : data.forks_count,
      remaining: res.remaining,
      anonymous: !conn.token,
    };
  }

  return { request, paginate, fetchRepository, checkRepository };
}

module.exports = {
  create, connectionFor, slugFromUrl, stamp, text, ForgeError, PROVIDERS,
  // The per-forge normalisers, so the webhook receiver maps a delivered object
  // with the same code a pull maps a fetched one.
  NORMALISERS: { github: githubItems, gitlab: gitlabItems, forgejo: forgejoItems },
};
