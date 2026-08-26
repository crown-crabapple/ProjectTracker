/**
 * Who may do what.
 *
 * Permissions resolve per (user, project): the union of the permissions of every
 * role granted to that user directly and through any group they belong to. An
 * administrator has everything without a membership, which is the only special
 * case and is checked first.
 *
 * The union is deliberate. A person who is a Reader directly and a Maintainer
 * through the Platform group is a Maintainer: taking the intersection would mean
 * adding somebody to a group could silently reduce their access, and nobody
 * would ever work out why.
 *
 * Two permissions are load-bearing beyond their name:
 *
 *   comment_internal — reading internal comments as well as writing them. A
 *     placeholder user and a Reader do not have it, which is what makes an
 *     internal comment internal. It is checked on the read path, not filtered in
 *     the UI, because a UI filter is a filter an API call goes around.
 *
 *   sign_gate — recording a phase gate as met. Held by Owner only, so a gate
 *     stays the owner's to sign.
 */

'use strict';

const db = require('../db');

/** The permission codes a user holds on a project. Returns a Set. */
async function permissionsFor(userId, projectId) {
  const user = await db.one('SELECT id, is_admin, kind, active FROM users WHERE id = ?', [userId]);
  if (!user || !user.active) return new Set();
  if (user.is_admin) {
    const all = await db.query('SELECT code FROM permissions');
    return new Set(all.map((r) => r.code));
  }
  const rows = await db.query(`
    SELECT DISTINCT p.code
      FROM memberships m
      LEFT JOIN user_group_members ugm ON ugm.group_id = m.group_id AND ugm.user_id = ?
      JOIN membership_roles mr ON mr.membership_id = m.id
      JOIN role_permissions rp ON rp.role_id = mr.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE m.project_id = ?
       AND (m.user_id = ? OR ugm.user_id = ?)`,
  [userId, projectId, userId, userId]);
  return new Set(rows.map((r) => r.code));
}

/** Every project the user can see, with the permission set for each. */
async function visibleProjects(userId) {
  const user = await db.one('SELECT id, is_admin FROM users WHERE id = ?', [userId]);
  if (!user) return [];
  if (user.is_admin) {
    return db.query('SELECT id FROM projects WHERE archived = 0 ORDER BY id');
  }
  return db.query(`
    SELECT DISTINCT pr.id
      FROM projects pr
      JOIN memberships m ON m.project_id = pr.id
      LEFT JOIN user_group_members ugm ON ugm.group_id = m.group_id AND ugm.user_id = ?
     WHERE pr.archived = 0
       AND (m.user_id = ? OR ugm.user_id = ? OR pr.public = 1)
     ORDER BY pr.id`, [userId, userId, userId]);
}

/**
 * Throw unless the user holds `code` on `projectId`.
 *
 * The error carries `status = 403` so the HTTP layer does not have to interpret
 * the message, and names the permission, because "forbidden" with no name is a
 * support ticket.
 */
async function require_(userId, projectId, code) {
  const held = await permissionsFor(userId, projectId);
  if (!held.has(code)) {
    const e = new Error(`you do not have "${code}" on this project`);
    e.status = 403;
    throw e;
  }
  return held;
}

/**
 * Can this user edit this work package? `edit_work_packages` is any of them;
 * `edit_own_work_packages` is the ones they authored or are assigned.
 */
function canEditWorkPackage(perms, wp, userId) {
  if (perms.has('edit_work_packages')) return true;
  if (!perms.has('edit_own_work_packages')) return false;
  return Number(wp.author_id) === Number(userId) || Number(wp.assignee_id) === Number(userId);
}

/** Whether internal comments are readable. Used on every comment read path. */
const seesInternal = (perms) => perms.has('comment_internal');

module.exports = { permissionsFor, visibleProjects, require: require_, canEditWorkPackage, seesInternal };
