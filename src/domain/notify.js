/**
 * Notifications and the activity trail.
 *
 * Two tables, two jobs, and they are not the same job:
 *
 *   activities    what happened, to the project. Never deleted, never capped.
 *                 The SeedFall tracker capped its log at 400 entries and the cost
 *                 showed up the first time nine routine entries pushed a real
 *                 decision out of the window.
 *
 *   notifications what one person needs to be told. Read state lives here, so
 *                 marking something read cannot erase the fact it happened.
 *
 * Every write path in the app comes through `record()`. An automation and the
 * MCP write tool come through it too, with `actorLabel` set instead of
 * `actorId`, so an automated change is never indistinguishable from a human one.
 */

'use strict';

const db = require('./../db');

/**
 * Append one activity entry and fan out the notifications it implies.
 *
 * `tx` is an optional transaction handle — pass it and the activity lands in the
 * same transaction as the change it describes, so a change can never exist
 * without its trail.
 */
async function record(entry, tx = db) {
  const {
    projectId = null, workPackageId = null, actorId = null, actorLabel = null,
    kind, verb, detail = null, targetLabel = null, from = null, to = null,
  } = entry;
  const id = await tx.insert('activities', {
    project_id: projectId,
    work_package_id: workPackageId,
    // A labelled actor is a machine, and the label replaces the id rather than
    // sitting beside it. The MCP write tools borrow the authority of the person
    // who issued the token; recording that person as the actor would make an
    // automated change indistinguishable from a human one, which is the one
    // thing this table exists to prevent. Enforced here rather than at each
    // call site, because a call site that forgets is a call site that lies.
    actor_id: actorLabel ? null : actorId,
    actor_label: actorLabel,
    kind,
    verb,
    detail,
    target_label: targetLabel,
    from_value: from,
    to_value: to,
  });
  return id;
}

/** One notification. Returns its id, or null when there is nobody to tell. */
async function notify({ userId, kind, title, detail = null, actorId = null, actorLabel = null,
  projectId = null, workPackageId = null }, tx = db) {
  if (!userId) return null;
  // Never notify somebody about their own action. It is noise, and it trains
  // people to stop reading the inbox. A machine's action is not their own
  // action, even when it ran on their token, so the suppression does not apply
  // to a labelled actor — being told what the assistant did on your behalf is
  // the point.
  if (!actorLabel && actorId && Number(actorId) === Number(userId)) return null;
  return tx.insert('notifications', {
    user_id: userId, kind, title, detail,
    // Same rule as the activity trail: the label replaces the id.
    actor_id: actorLabel ? null : actorId, actor_label: actorLabel,
    project_id: projectId, work_package_id: workPackageId,
  });
}

/**
 * Everybody who should hear about a change to a work package: its assignee, its
 * accountable, and its watchers. Deduplicated, and the actor removed.
 *
 * A placeholder user is included in the list and excluded from anything internal
 * downstream, rather than being filtered out here — a placeholder holding an
 * assignment is a real plan, and the team planner has to show its notifications
 * to whoever converts it later.
 */
async function audienceFor(workPackageId, { exclude = null } = {}, tx = db) {
  const rows = await tx.query(`
    SELECT DISTINCT u.id, u.kind
      FROM users u
     WHERE u.active = 1 AND u.id IN (
       SELECT assignee_id    FROM work_packages WHERE id = ? AND assignee_id IS NOT NULL
       UNION SELECT accountable_id FROM work_packages WHERE id = ? AND accountable_id IS NOT NULL
       UNION SELECT user_id        FROM work_package_watchers WHERE work_package_id = ?
     )`, [workPackageId, workPackageId, workPackageId]);
  return rows.filter((r) => !exclude || Number(r.id) !== Number(exclude));
}

/**
 * Extract @mentions from a comment body and resolve them to users.
 *
 * Matches on login, and on a name with spaces collapsed, so both `@stephen` and
 * `@m.odell` land. An unresolved mention is returned so the caller can tell the
 * author it did not reach anybody — a silent no-op mention is how a question
 * goes unanswered for a week.
 */
async function resolveMentions(body, tx = db) {
  // Trailing punctuation is sentence, not handle: '@rkessler.' mentions
  // rkessler. Without the trim it reported the mention as unresolved and told
  // nobody.
  const handles = [...String(body || '').matchAll(/@([A-Za-z0-9._-]{2,80})/g)]
    .map((m) => m[1].replace(/[._-]+$/, ''))
    .filter((h) => h.length >= 2);
  if (!handles.length) return { users: [], unresolved: [] };
  const lowered = [...new Set(handles.map((h) => h.toLowerCase()))];
  const clause = db.inClause(lowered);
  const rows = await tx.query(`
    SELECT id, login, name FROM users
     WHERE active = 1
       AND (LOWER(login) IN ${clause.sql}
            OR LOWER(REPLACE(name, ' ', '')) IN ${clause.sql})`,
  [...clause.params, ...clause.params]);
  const matched = new Set();
  for (const r of rows) {
    matched.add(String(r.login || '').toLowerCase());
    matched.add(String(r.name || '').replace(/ /g, '').toLowerCase());
  }
  return { users: rows, unresolved: lowered.filter((h) => !matched.has(h)) };
}

/**
 * Evaluate every enabled date alert and produce the notifications that are due.
 *
 * A rule that has already produced a notification for the same work package on
 * the same day does not produce another. Without that check, running the sweep
 * twice in a morning tells you about the same overdue task twice, and the third
 * time you stop reading it.
 */
async function runDateAlerts(today, tx = db) {
  const alerts = await tx.query(`
    SELECT a.*, u.name AS user_name
      FROM date_alerts a JOIN users u ON u.id = a.user_id
     WHERE a.enabled = 1 AND u.active = 1`);
  const created = [];
  for (const alert of alerts) {
    const where = [];
    const params = [];
    if (alert.project_id) { where.push('wp.project_id = ?'); params.push(alert.project_id); }
    if (alert.only_assigned) { where.push('wp.assignee_id = ?'); params.push(alert.user_id); }
    if (alert.only_watched) {
      where.push('EXISTS (SELECT 1 FROM work_package_watchers w WHERE w.work_package_id = wp.id AND w.user_id = ?)');
      params.push(alert.user_id);
    }
    let rule = '1 = 0';
    if (alert.rule === 'overdue') { rule = 'wp.due_date < ? AND s.is_closed = 0'; params.push(today); }
    else if (alert.rule === 'due_soon') {
      rule = 'wp.due_date >= ? AND wp.due_date <= DATE_ADD(?, INTERVAL ? DAY) AND s.is_closed = 0';
      params.push(today, today, alert.threshold_days);
    } else if (alert.rule === 'start_soon') {
      rule = 'wp.start_date >= ? AND wp.start_date <= DATE_ADD(?, INTERVAL ? DAY) AND s.is_closed = 0';
      params.push(today, today, alert.threshold_days);
    } else if (alert.rule === 'no_dates') rule = 'wp.due_date IS NULL AND s.is_closed = 0';
    else if (alert.rule === 'unassigned') {
      rule = 'wp.assignee_id IS NULL AND s.is_closed = 0 AND wp.due_date IS NOT NULL AND wp.due_date <= DATE_ADD(?, INTERVAL ? DAY)';
      params.push(today, alert.threshold_days);
    }

    const rows = await tx.query(`
      SELECT wp.id, wp.wp_key, wp.subject, wp.due_date, wp.project_id
        FROM work_packages wp
        JOIN statuses s ON s.id = wp.status_id
       WHERE ${rule}${where.length ? ' AND ' + where.join(' AND ') : ''}
       ORDER BY wp.due_date LIMIT 200`, params);

    for (const wp of rows) {
      const already = await tx.scalar(`
        SELECT COUNT(*) FROM notifications
         WHERE user_id = ? AND work_package_id = ? AND kind = 'date_alert'
           AND DATE(created_at) = ?`, [alert.user_id, wp.id, today]);
      if (Number(already) > 0) continue;
      const title = alert.rule === 'overdue'
        ? 'Date alert — overdue'
        : alert.rule === 'unassigned'
          ? 'Date alert — due with no assignee'
          : `Date alert — ${alert.rule.replace('_', ' ')}`;
      const id = await tx.insert('notifications', {
        user_id: alert.user_id, kind: 'date_alert', title,
        detail: `${wp.wp_key} · ${wp.subject}`,
        project_id: wp.project_id, work_package_id: wp.id,
      });
      created.push({ id, user_id: alert.user_id, work_package_id: wp.id, rule: alert.rule });
    }
    await tx.run('UPDATE date_alerts SET last_ran_at = NOW() WHERE id = ?', [alert.id]);
  }
  return created;
}

module.exports = { record, notify, audienceFor, resolveMentions, runDateAlerts };
