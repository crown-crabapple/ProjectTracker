#!/usr/bin/env node
/**
 * The web server.
 *
 *   node src/http/server.js [--port 4180] [--host 127.0.0.1]
 *
 * Bound to loopback unless PT_HOST says otherwise, because the default should
 * not be "reachable from the network".
 *
 * Every /api route below is called by public/app.js. A route nothing calls is a
 * second write path that will one day disagree with the first, so there are
 * none: if the browser does not use it, it is not here.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const db = require('../db');
const { Router, HttpError, badRequest, unauthorized, notFound, forbidden } = require('./router');
const body = require('./body');
const auth = require('./auth');
const access = require('../domain/access');
const notifyDomain = require('../domain/notify');
const query = require('../domain/query');
const files = require('../domain/files');

const views = require('../api/views');
const views2 = require('../api/views2');
const views3 = require('../api/views3');
const views4 = require('../api/views4');
const mut = require('../api/mutations');
const mut2 = require('../api/mutations2');
const exporters = require('../api/exports');

const PUBLIC = path.join(config.root, 'public');
const router = new Router();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// --------------------------------------------------------------------- helpers

/** Build the request context: who, what they can see, and today's date. */
async function contextFor(req) {
  const user = await auth.currentUser(req);
  if (!user) throw unauthorized();
  const visible = await access.visibleProjects(user.id);
  return {
    user,
    visibleProjectIds: visible.map((r) => Number(r.id)),
    today: new Date().toISOString().slice(0, 10),
  };
}

/** Assert the caller can see this project, and return its numeric id. */
async function scopeProject(ctx, raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('project id must be a positive integer');
  if (!ctx.visibleProjectIds.includes(id)) throw notFound('no such project');
  return id;
}

/**
 * Turn query-string parameters into a filter object for src/domain/query.
 *
 * Only the keys listed are read. An unrecognised parameter is ignored here
 * rather than passed through, because query.select() throws on an unknown filter
 * and a typo in a URL should not be a 400 on a page load.
 */
function filtersFromQuery(url) {
  const p = url.searchParams;
  const out = {};
  const list = (k) => (p.get(k) ? p.get(k).split(',').filter(Boolean) : null);
  if (p.get('q')) out.q = p.get('q');
  if (list('status')) out.status = list('status');
  if (list('type')) out.type = list('type');
  if (list('priority')) out.priority = list('priority');
  if (list('version')) out.version = list('version');
  if (list('sprint')) out.sprint = list('sprint');
  if (p.get('assignee')) out.assignee = Number(p.get('assignee'));
  if (p.get('accountable')) out.accountable = Number(p.get('accountable'));
  if (p.get('open') === '1') out.open = true;
  if (p.get('closed') === '1') out.closed = true;
  if (p.get('overdue') === '1') out.overdue = true;
  if (p.get('unassigned') === '1') out.unassigned = true;
  if (p.get('no_sprint') === '1') out.no_sprint = true;
  if (p.get('involves')) out.involves = Number(p.get('involves'));
  if (p.get('custom_field') && p.get('custom_value')) {
    out.custom = { field: p.get('custom_field'), value: p.get('custom_value') };
  }
  return out;
}

// ------------------------------------------------------------------ auth routes

router.get('/api/session', async ({ req }) => {
  const user = await auth.currentUser(req);
  return { user: user || null };
});

router.post('/api/session', async ({ req, res }) => {
  const { fields } = await body.read(req);
  if (!fields.login || !fields.password) throw badRequest('login and password are required');
  const { token } = await auth.signIn(String(fields.login), String(fields.password), req.headers['user-agent']);
  res.setHeader('Set-Cookie', auth.cookieHeader(token, { secure: isHttps(req) }));
  const user = await auth.currentUser({ headers: { cookie: `${auth.COOKIE}=${token}` } });
  return { user };
});

router.delete('/api/session', async ({ req, res }) => {
  const token = auth.parseCookies(req.headers.cookie)[auth.COOKIE];
  await auth.signOut(token);
  res.setHeader('Set-Cookie', auth.cookieHeader('', { clear: true, secure: isHttps(req) }));
  return { ok: true };
});

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https'
  || Boolean(req.socket && req.socket.encrypted);

// ------------------------------------------------------------------ read routes

router.get('/api/bootstrap', async ({ req }) => views.bootstrap(await contextFor(req)));

router.get('/api/my', async ({ req }) => views.myPage(await contextFor(req)));

router.get('/api/portfolio', async ({ req, url }) => {
  const ctx = await contextFor(req);
  return views2.portfolio(ctx, { favouritesOnly: url.searchParams.get('favourites') === '1' });
});

router.get('/api/projects/:id/overview', async ({ req, params }) => {
  const ctx = await contextFor(req);
  return views2.overview(ctx, await scopeProject(ctx, params.id));
});

router.get('/api/work', async ({ req, url }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  return views2.work(ctx, {
    projectId,
    filters: filtersFromQuery(url),
    sort: url.searchParams.get('sort') || 'id',
    flat: url.searchParams.get('flat') === '1',
  });
});

router.get('/api/gantt', async ({ req, url }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  return views2.gantt(ctx, { projectId, baselineId: url.searchParams.get('baseline') || null });
});

router.get('/api/boards', async ({ req, url }) => {
  const ctx = await contextFor(req);
  return views3.boards(ctx, {
    projectId: await scopeProject(ctx, url.searchParams.get('project')),
    boardType: url.searchParams.get('type') || 'status',
  });
});

router.get('/api/backlogs', async ({ req, url }) => {
  const ctx = await contextFor(req);
  return views3.backlogs(ctx, { projectId: await scopeProject(ctx, url.searchParams.get('project')) });
});

router.get('/api/roadmap', async ({ req }) => views3.roadmap(await contextFor(req)));

router.get('/api/calendar', async ({ req, url }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  return views3.calendar(ctx, { projectId, month: url.searchParams.get('month') });
});

router.get('/api/planner', async ({ req, url }) => {
  const ctx = await contextFor(req);
  return views3.planner(ctx, {
    weeks: url.searchParams.get('weeks'), from: url.searchParams.get('from'),
  });
});

router.get('/api/activity', async ({ req }) => views3.activityPage(await contextFor(req)));

router.get('/api/wiki', async ({ req, url }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  return views4.wiki(ctx, { projectId, slug: url.searchParams.get('doc') });
});

router.get('/api/meetings', async ({ req, url }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  return views4.meetings(ctx, { projectId, meetingId: url.searchParams.get('meeting') });
});

router.get('/api/connect', async ({ req }) => {
  const ctx = await contextFor(req);
  if (!ctx.user.is_admin) throw forbidden('the connections page is administrator-only');
  return views4.connect(ctx);
});

router.get('/api/admin', async ({ req, url }) => {
  const ctx = await contextFor(req);
  if (!ctx.user.is_admin) throw forbidden('administration is administrator-only');
  return views4.admin(ctx, { tab: url.searchParams.get('tab') || 'fields' });
});

router.get('/api/wp/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const wp = await query.byId(Number(params.id));
  if (!wp || !ctx.visibleProjectIds.includes(Number(wp.project_id))) throw notFound('no such work package');
  return views4.drawer(ctx, Number(params.id));
});

// ----------------------------------------------------------------- write routes

router.post('/api/wp', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.createWorkPackage(ctx, fields);
});

router.patch('/api/wp/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.updateWorkPackage(ctx, Number(params.id), fields);
});

router.post('/api/wp/:id/watch', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.watch(ctx, Number(params.id), fields.user_id, fields.on !== false);
});

router.post('/api/wp/:id/comments', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.addComment(ctx, {
    containerType: 'work_package', containerId: Number(params.id),
    body: fields.body, internal: Boolean(fields.internal),
  });
});

router.post('/api/wp/:id/attachments', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const parsed = await body.read(req);
  if (!parsed.files.length) throw badRequest('no file in the request');
  const out = [];
  for (const f of parsed.files) {
    out.push(await mut.attach(ctx, {
      containerType: 'work_package', containerId: Number(params.id),
      file: f, description: parsed.fields.description || null,
    }));
  }
  return { attachments: out };
});

router.post('/api/wp/:id/share', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.share(ctx, Number(params.id), fields);
});

router.delete('/api/shares/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  return mut.revokeShare(ctx, Number(params.id));
});

router.post('/api/projects', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.createProject(ctx, fields);
});

router.post('/api/projects/:id/favourite', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setFavourite(ctx, await scopeProject(ctx, params.id), fields.on !== false);
});

router.post('/api/projects/:id/health', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setHealth(ctx, await scopeProject(ctx, params.id), fields);
});

router.post('/api/projects/:id/gates/:phaseId', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut.signGate(ctx, await scopeProject(ctx, params.id), Number(params.phaseId), fields);
});

router.post('/api/projects/:id/baseline', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.takeBaseline(ctx, await scopeProject(ctx, params.id), fields);
});

router.post('/api/projects/:id/reschedule', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  const id = await scopeProject(ctx, params.id);
  await access.require(ctx.user.id, id, 'edit_work_packages');
  return mut.reschedule(id, { apply: fields.apply === true, actorId: ctx.user.id });
});

router.post('/api/sprints/:id/close', async ({ req, params }) => {
  const ctx = await contextFor(req);
  return mut2.closeSprint(ctx, Number(params.id));
});

router.post('/api/boards/move', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.moveCard(ctx, {
    workPackageId: Number(fields.work_package_id),
    boardType: fields.board_type,
    columnKey: fields.column,
    position: fields.position,
  });
});

router.post('/api/backlog/reorder', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.reorderBacklog(ctx, await scopeProject(ctx, fields.project_id), fields.ids);
});

router.patch('/api/documents/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.saveDocument(ctx, Number(params.id), {
    body: fields.body, baseRevision: fields.base_revision, note: fields.note,
  });
});

router.post('/api/documents/:id/presence', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.touchPresence(ctx, Number(params.id), fields);
});

router.post('/api/meetings/:id/agenda', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.addAgendaItem(ctx, Number(params.id), fields);
});

router.post('/api/meetings/:id/minutes', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.recordMinutes(ctx, Number(params.id), fields);
});

router.post('/api/notifications/read', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.markRead(ctx, fields.all ? 'all' : fields.ids);
});

router.patch('/api/preferences', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setPreferences(ctx, fields);
});

router.post('/api/allocations', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setAllocation(ctx, {
    userId: Number(fields.user_id) || ctx.user.id,
    weekStart: fields.week_start, hours: fields.hours,
    projectId: fields.project_id || null, workPackageId: fields.work_package_id || null,
  });
});

router.post('/api/alerts/run', async ({ req }) => {
  const ctx = await contextFor(req);
  const created = await notifyDomain.runDateAlerts(ctx.today);
  return { created: created.length, notifications: created };
});

// ------------------------------------------------------------ administration

router.patch('/api/admin/statuses/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setStatusWeight(ctx, Number(params.id),
    fields.weight === undefined ? null : fields.weight);
});

router.patch('/api/admin/automations/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.toggleAutomation(ctx, Number(params.id), fields);
});

router.post('/api/admin/custom-fields', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.saveCustomField(ctx, fields);
});

router.post('/api/custom-values', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.setCustomValue(ctx, {
    fieldId: Number(fields.field_id), entityType: fields.entity_type || 'work_package',
    entityId: Number(fields.entity_id), value: fields.value,
  });
});

router.post('/api/admin/mcp-tokens', async ({ req }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.issueMcpToken(ctx, fields);
});

router.delete('/api/admin/mcp-tokens/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  return mut2.revokeMcpToken(ctx, Number(params.id));
});

router.post('/api/admin/initiation/:id', async ({ req, params }) => {
  const ctx = await contextFor(req);
  const { fields } = await body.read(req);
  return mut2.decideInitiation(ctx, Number(params.id), fields);
});

/**
 * The email intake endpoint. A mail transport POSTs a parsed message here.
 *
 * Guarded by a shared secret in a header rather than a session, because the
 * caller is a machine with no cookie. The secret is PT_SECRET; without it set,
 * the endpoint refuses everything rather than accepting everything.
 */
router.post('/api/intake/email', async ({ req }) => {
  const secret = req.headers['x-intake-secret'];
  if (!config.secret) throw forbidden('PT_SECRET is not set, so the intake is closed');
  if (secret !== config.secret) throw unauthorized('bad intake secret');
  const { fields } = await body.read(req);
  return mut2.receiveEmail(fields);
});

// ----------------------------------------------------------- exports and files

router.get('/api/export/work/:format', async ({ req, url, params, res }) => {
  const ctx = await contextFor(req);
  const projectId = url.searchParams.get('project')
    ? await scopeProject(ctx, url.searchParams.get('project')) : null;
  const data = await views2.work(ctx, {
    projectId, filters: filtersFromQuery(url), sort: url.searchParams.get('sort') || 'id', flat: true,
  });
  const cols = exporters.WP_COLUMNS;
  const title = projectId
    ? `Work packages — project ${projectId}`
    : 'Work packages — whole portfolio';
  const stamp = ctx.today;

  if (params.format === 'csv') {
    res.setHeader('Content-Disposition', `attachment; filename="work-packages-${stamp}.csv"`);
    return { raw: exporters.toCsv(cols, data.rows), type: 'text/csv; charset=utf-8' };
  }
  if (params.format === 'xlsx') {
    res.setHeader('Content-Disposition', `attachment; filename="work-packages-${stamp}.xlsx"`);
    return {
      raw: exporters.toXlsx(cols, data.rows),
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  }
  if (params.format === 'pdf') {
    res.setHeader('Content-Disposition', `attachment; filename="work-packages-${stamp}.pdf"`);
    return { raw: exporters.toPdf(title, cols, data.rows), type: 'application/pdf' };
  }
  throw badRequest('format must be csv, xlsx or pdf');
});

router.get('/api/attachments/:id', async ({ req, params, res }) => {
  const ctx = await contextFor(req);
  const meta = await db.one('SELECT * FROM attachments WHERE id = ?', [Number(params.id)]);
  if (!meta) throw notFound('no such attachment');
  if (meta.container_type === 'work_package') {
    const wp = await db.one('SELECT project_id FROM work_packages WHERE id = ?', [meta.container_id]);
    if (!wp || !ctx.visibleProjectIds.includes(Number(wp.project_id))) throw notFound('no such attachment');
  }
  const { row, buffer } = await files.read(Number(params.id));
  res.setHeader('Content-Disposition',
    `${files.disposition(row)}; filename="${row.filename.replace(/"/g, '')}"`);
  // Belt and braces against a browser sniffing a stored file into something
  // executable.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return { raw: buffer, type: row.content_type };
});

/** The iCal feed. Token in the path: a calendar client cannot send a header. */
router.get('/ical/:token', async ({ params, res }) => {
  const token = String(params.token).replace(/\.ics$/, '');
  const feed = await exporters.icalFor(token);
  if (!feed) throw notFound('no such calendar feed');
  res.setHeader('Content-Disposition', 'inline; filename="projecttracker.ics"');
  return { raw: exporters.toIcal(feed), type: 'text/calendar; charset=utf-8' };
});

/**
 * A shared project list, read by link with no account.
 *
 * The list stores its FILTER, never the resulting set of project ids. A list
 * that froze its members would go stale silently, and a stale shared link is
 * worse than no link — so this re-evaluates the filter against what the list's
 * owner can see now.
 */
router.get('/api/list-share/:token', async ({ params }) => {
  const token = String(params.token);
  if (!/^[A-Za-z0-9]{8,48}$/.test(token)) throw badRequest('not a share token');
  const share = await db.one(`
    SELECT s.*, l.name, l.filters, l.owner_id, u.name AS owner_name
      FROM project_list_shares s
      JOIN project_lists l ON l.id = s.list_id
      JOIN users u ON u.id = l.owner_id
     WHERE s.token = ?`, [token]);
  if (!share) throw notFound('that link is not valid');
  if (share.revoked_at) throw unauthorized('that link has been revoked');
  if (share.expires_at && new Date(String(share.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
    throw unauthorized('that link has expired');
  }

  // Evaluated as the OWNER, because the person opening the link has no account.
  // That is what makes it a share: the owner is lending their view, and the
  // expiry and the revoke are how they take it back.
  const visible = await access.visibleProjects(share.owner_id);
  const ctx = {
    user: { id: share.owner_id, highlight_mode: 'status' },
    visibleProjectIds: visible.map((r) => Number(r.id)),
    today: new Date().toISOString().slice(0, 10),
  };
  const filters = db.json(share.filters, {}) || {};
  const data = await views2.portfolio(ctx, {
    favouritesOnly: Boolean(filters.favourite),
    programCode: filters.program ? String(filters.program).toUpperCase() : null,
  });
  const programs = data.programs;

  return {
    kind: 'list',
    name: share.name,
    shared_by: share.owner_name,
    permission: share.permission,
    expires_at: share.expires_at,
    filters,
    kpis: data.kpis,
    programs,
    note: 'Shared by link. It shows what the list selects for its owner now, not a frozen copy.',
  };
});

/**
 * A shared work package, read by link with no account.
 *
 * Internal comments are excluded here as well as in the query, because this is
 * the one path where the reader has no permissions at all and a mistake is a
 * disclosure to whoever has the link.
 */
router.get('/api/share/:token', async ({ params }) => {
  const share = await auth.shareFor(params.token);
  const wp = await query.byId(share.work_package_id);
  if (!wp) throw notFound('that work package is gone');
  const comments = await db.query(`
    SELECT c.body, c.created_at, u.name AS author FROM comments c
      LEFT JOIN users u ON u.id = c.author_id
     WHERE c.container_type = 'work_package' AND c.container_id = ? AND c.internal = 0
     ORDER BY c.created_at`, [share.work_package_id]);
  const ctx = {
    user: { highlight_mode: 'status' },
    today: new Date().toISOString().slice(0, 10),
  };
  return {
    permission: share.permission,
    expires_at: share.expires_at,
    wp: views.row(wp, ctx),
    comments: comments.map((c) => ({ ...c, when: views.ago(c.created_at) })),
    note: 'Shared by link. Internal comments are never included in a share.',
  };
});

// ------------------------------------------------------------- static and index

/**
 * A share link has to work in a browser, not only as an API call.
 *
 * Without this, /share/<token> fell through to the SPA shell, which asked for a
 * session, found none, and showed a sign-in card — to somebody who by definition
 * has no account. That is the whole point of a share link failing.
 */
router.get('/share/:token', async ({ res }) => {
  const file = path.join(PUBLIC, 'share.html');
  if (!fs.existsSync(file)) throw notFound('the share page is missing');
  return { raw: fs.readFileSync(file), type: MIME['.html'] };
});
router.get('/share/list/:token', async ({ res }) => {
  const file = path.join(PUBLIC, 'share.html');
  if (!fs.existsSync(file)) throw notFound('the share page is missing');
  return { raw: fs.readFileSync(file), type: MIME['.html'] };
});

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  // resolve() then prefix-check: the only traversal defence that does not depend
  // on spotting every encoding of '..'.
  if (!file.startsWith(PUBLIC + path.sep) && file !== path.join(PUBLIC, 'index.html')) {
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Anything not on disk is a client-side route. Serving index.html means a
    // deep link survives a refresh.
    const index = path.join(PUBLIC, 'index.html');
    if (!fs.existsSync(index)) {
      // No front end built yet. This used to read the file unconditionally and
      // the ENOENT escaped the request handler, which killed the process — one
      // curl to a wrong path took the server down.
      return send(res, 404, 'the front end is not built: public/index.html is missing',
        'text/plain; charset=utf-8');
    }
    return send(res, 200, fs.readFileSync(index), MIME['.html']);
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // The app is self-contained: no CDN, no external font, no inline script. So
    // the policy can be strict, and a strict policy is what makes a stored
    // comment body harmless.
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
      + "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const found = router.resolve(req.method, url.pathname);

  if (!found) {
    // An /api path that matches nothing is a 404 in JSON, never the SPA shell.
    // Falling through to index.html handed a client HTML where it expected JSON,
    // and the resulting parse error named the wrong problem.
    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `no such endpoint: ${req.method} ${url.pathname}` });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        return serveStatic(res, url.pathname);
      } catch (e) {
        console.error(`static ${url.pathname}`, e);
        return sendJson(res, 500, { error: 'could not read that file' });
      }
    }
    return sendJson(res, 404, { error: 'no such endpoint' });
  }
  if (!found.handler) {
    res.setHeader('Allow', found.allow.join(', '));
    return sendJson(res, 405, { error: `use ${found.allow.join(' or ')} here` });
  }

  try {
    const out = await found.handler({ req, res, url, params: found.params });
    if (out && out.raw !== undefined) return send(res, 200, out.raw, out.type);
    return sendJson(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    const status = e instanceof HttpError || e.status ? e.status || 500 : 500;
    if (status >= 500) {
      // A 500 is a bug. Log the stack for whoever has to fix it, and tell the
      // client nothing about it.
      console.error(`${req.method} ${url.pathname}`, e);
      return sendJson(res, 500, { error: 'something went wrong on the server' });
    }
    const payload = { error: e.message };
    // A conflict on a document save carries the other version, so the client can
    // show both rather than just refusing.
    if (e.currentBody !== undefined) { payload.currentBody = e.currentBody; payload.currentRevision = e.currentRevision; }
    return sendJson(res, status, payload);
  }
});

async function main() {
  const argPort = process.argv.indexOf('--port');
  const argHost = process.argv.indexOf('--host');
  const port = argPort > -1 ? Number(process.argv[argPort + 1]) : config.http.port;
  const host = argHost > -1 ? process.argv[argHost + 1] : config.http.host;

  // Fail here rather than on the first request: a server that starts and then
  // 500s on everything is harder to diagnose than one that refuses to start.
  const version = await db.scalar('SELECT VERSION()');
  const counts = await db.one(`SELECT
    (SELECT COUNT(*) FROM projects) AS projects,
    (SELECT COUNT(*) FROM work_packages) AS work_packages,
    (SELECT COUNT(*) FROM users WHERE active = 1) AS users`);
  const pruned = await auth.pruneSessions();
  fs.mkdirSync(config.filesDir, { recursive: true });

  // A port already in use is the most common startup failure and the default
  // message for it is a stack trace. Naming the port and the likely cause saves
  // the next person a minute every time.
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  port ${port} is already in use — another ProjectTracker is probably running.`);
      console.error(`  Stop it, or start this one on another port: node src/http/server.js --port ${port + 1}\n`);
      process.exit(1);
    }
    throw e;
  });

  server.listen(port, host, () => {
    console.log('');
    console.log(`  ProjectTracker   http://${host}:${port}/`);
    console.log(`  database         ${config.db.database} on ${config.db.host} (${version})`);
    console.log(`  content          ${counts.projects} projects · ${counts.work_packages} work packages · ${counts.users} users`);
    console.log(`  files            ${config.filesDir}`);
    if (pruned) console.log(`  pruned           ${pruned} expired session(s)`);
    if (!config.secret) console.log('  ! PT_SECRET is unset — the email intake endpoint is closed');
    console.log('  ctrl-c to stop');
    console.log('');
  });

  setInterval(() => { auth.pruneSessions().catch(() => {}); }, 3600_000).unref();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\n  cannot start: ${e.message}\n`);
    console.error('  Check .env, then run `node db/migrate.js` and `node db/seed.js`.\n');
    process.exit(1);
  });
}

module.exports = { server, router, contextFor, filtersFromQuery, send, sendJson };
