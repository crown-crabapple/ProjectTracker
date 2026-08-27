/**
 * The write side of the deck: repositories, the mapping, and the links.
 *
 * Same four steps as `mutations.js` and in the same order — check the
 * permission, validate, write, append to the trail, all in one transaction —
 * and the pull itself is not here: it lives in `src/gitdeck/pull.js` because it
 * has a network call in the middle and a transaction must not.
 *
 * A LINK IS NEVER DELETED. Removing one sets `removed_at` and keeps the row,
 * like a revoked share and a rejected email, and the puller then leaves that
 * pair alone for ever: a person deciding that PR 978 is not F-LOAD-012 is a
 * decision, and an integration that re-made the link every quarter of an hour
 * would be an integration somebody turns off.
 */

'use strict';

const db = require('../db');
const access = require('../domain/access');
const notify = require('../domain/notify');
const gitdeck = require('../domain/gitdeck');
const client = require('../gitdeck/client');
const { badRequest, notFound, forbidden, conflict } = require('../http/router');

const actor = (ctx) => ({ actorId: ctx.user.id, actorLabel: ctx.actorLabel || null });

const SCM = ['git', 'svn', 'github', 'gitlab', 'forgejo'];

/**
 * `token_env` names an environment variable. It must never be a token.
 *
 * Upper case is the test that does the work. A variable name here is
 * conventionally upper case — GITHUB_TOKEN, PT_FORGE_TOKEN — and every forge's
 * personal access token is lower case with a prefix (ghp_, github_pat_, glpat-,
 * gho_), so requiring capitals refuses a pasted credential by its shape rather
 * than by a list of prefixes that will be out of date within a year. The known
 * prefixes are checked as well, because the message they earn is a better one
 * than "must be upper case".
 */
const TOKEN_SHAPES = /^(gh[pousr]_|github_pat_|glpat-|glptt-|sk-|xox[baprs]-)/i;

function assertVariableName(value) {
  if (TOKEN_SHAPES.test(value)) {
    throw badRequest(
      'that looks like a token, not the name of a variable. Nothing in this database may hold a '
      + 'credential: put the token in the environment and record the NAME of the variable here — '
      + 'GITHUB_TOKEN. See docs/decisions/0008.'
    );
  }
  if (!/^[A-Z][A-Z0-9_]{0,119}$/.test(value)) {
    throw badRequest(
      `"${value}" is not an environment variable name. It is upper case, letters, digits and `
      + 'underscores — GITHUB_TOKEN — and it is the NAME of the variable, never its value.'
    );
  }
}


/**
 * Connect a repository.
 *
 * `token_env` is the NAME of an environment variable and is validated as one.
 * Somebody pasting an actual token into that field is the failure this rule
 * exists to prevent, so a value that looks like a credential — anything outside
 * the shape of a variable name — is refused with the reason rather than stored.
 */
async function createRepository(ctx, input) {
  const projectId = Number(input.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) throw badRequest('project_id is required');
  await access.require(ctx.user.id, projectId, 'manage_repositories');

  const scm = String(input.scm || '').toLowerCase();
  if (!SCM.includes(scm)) throw badRequest(`scm must be one of ${SCM.join(', ')}`);
  const name = String(input.name || '').trim();
  const url = String(input.url || '').trim();
  if (!name) throw badRequest('a repository needs a name');
  if (!url) throw badRequest('a repository needs a url');

  const tokenEnv = input.token_env ? String(input.token_env).trim() : null;
  if (tokenEnv) assertVariableName(tokenEnv);
  if (input.hook_secret_env) assertVariableName(String(input.hook_secret_env).trim());

  const slug = input.slug ? String(input.slug).trim() : client.slugFromUrl(url);
  const apiBase = input.api_base ? String(input.api_base).trim() : null;
  if (scm === 'forgejo' && !apiBase) {
    throw badRequest('a forgejo repository needs api_base — there is no default host to guess');
  }

  const id = await db.transaction(async (tx) => {
    const newId = await tx.insert('repositories', {
      project_id: projectId, scm, name, url, slug, api_base: apiBase,
      default_branch: input.default_branch ? String(input.default_branch).trim() : null,
      token_env: tokenEnv,
      hook_secret_env: input.hook_secret_env ? String(input.hook_secret_env).trim() : null,
      state: 'off', pull_state: 'never',
      detail: 'connected, never pulled',
    });
    await notify.record({
      projectId, ...actor(ctx), kind: 'repo', verb: 'connected a repository',
      targetLabel: name, detail: `${scm} · ${url}${tokenEnv ? ` · token from ${tokenEnv}` : ' · no token'}`,
    }, tx);
    return newId;
  });
  return { id, name, scm, slug };
}

/**
 * Change where a repository is, which variables its secrets come from, and who
 * a webhook delivery acts as.
 *
 * `hook_actor` is the sharp one. Nobody starts a webhook, so a delivery that is
 * ever to move a work package has to borrow somebody's authority — the same
 * argument as an MCP token's issuer in `docs/decisions/0006`. It is checked here
 * rather than at delivery time: naming somebody who cannot edit work packages
 * in this project would produce a webhook that silently refused every status
 * change it implied, at three in the morning, with the reason in a table nobody
 * was looking at.
 */
async function updateRepository(ctx, id, patch) {
  const repo = await db.one('SELECT * FROM repositories WHERE id = ?', [id]);
  if (!repo) throw notFound('no such repository');
  await access.require(ctx.user.id, repo.project_id, 'manage_repositories');

  const changes = {};
  for (const field of ['name', 'url', 'slug', 'api_base', 'default_branch']) {
    if (patch[field] !== undefined) changes[field] = patch[field] === '' ? null : String(patch[field]).trim();
  }
  for (const field of ['token_env', 'hook_secret_env']) {
    if (patch[field] === undefined) continue;
    const value = patch[field] === '' || patch[field] === null ? null : String(patch[field]).trim();
    if (value) assertVariableName(value);
    changes[field] = value;
  }
  if (patch.hook_actor !== undefined) {
    const login = patch.hook_actor === '' || patch.hook_actor === null ? null : String(patch.hook_actor).trim();
    if (!login) {
      changes.hook_actor_id = null;
    } else {
      const user = await db.one(
        "SELECT id, name FROM users WHERE login = ? AND active = 1 AND kind = 'user'", [login]
      );
      if (!user) throw badRequest(`no active account with the login "${login}"`);
      const held = await access.permissionsFor(user.id, repo.project_id);
      if (!held.has('edit_work_packages') && !held.has('edit_own_work_packages')) {
        throw badRequest(
          `${user.name} cannot edit work packages in this project, so a delivery running as them `
          + 'could never move one. Name somebody who can, or leave it empty and the webhook will '
          + 'mirror without moving anything.'
        );
      }
      changes.hook_actor_id = user.id;
    }
  }
  if (!Object.keys(changes).length) throw badRequest('nothing to change');

  await db.transaction(async (tx) => {
    await tx.update('repositories', id, changes);
    await notify.record({
      projectId: repo.project_id, ...actor(ctx), kind: 'repo', verb: 'edited a repository',
      targetLabel: repo.name, detail: Object.keys(changes).join(', '),
    }, tx);
  });
  return { id: Number(id), ...changes };
}

/**
 * Set the key a repository knows a work package by.
 *
 * This is the column that makes `F-LOAD-012 maps to PR #978` possible at all:
 * `wp_key` is derived from the id and cannot be chosen, so a project whose
 * history calls a feature F-LOAD-012 needs somewhere to say so. Validated
 * against the shape the matcher can actually find, because a key that no branch
 * name could ever match is a key that silently never links to anything.
 */
async function setRefKey(ctx, workPackageId, refKey) {
  const wp = await db.one(
    'SELECT id, project_id, wp_key, ref_key, author_id, assignee_id FROM work_packages WHERE id = ?',
    [workPackageId]
  );
  if (!wp) throw notFound('no such work package');
  const perms = await access.permissionsFor(ctx.user.id, wp.project_id);
  if (!access.canEditWorkPackage(perms, wp, ctx.user.id)) {
    throw forbidden('you may not edit this work package');
  }

  const value = refKey === null || refKey === '' ? null : String(refKey).trim().toUpperCase();
  if (value && !gitdeck.isValidRefKey(value)) {
    throw badRequest(
      `"${refKey}" is not a key a repository could carry. A key is letters, optional `
      + 'sections, then digits — F-LOAD-012, B-UI-7, PH-2.'
    );
  }
  if (value) {
    const clash = await db.one(
      'SELECT wp_key FROM work_packages WHERE project_id = ? AND ref_key = ? AND id <> ?',
      [wp.project_id, value, workPackageId]
    );
    if (clash) throw conflict(`${clash.wp_key} already carries the key ${value} in this project`);
  }

  await db.transaction(async (tx) => {
    await tx.update('work_packages', workPackageId, { ref_key: value });
    await notify.record({
      projectId: wp.project_id, workPackageId: Number(workPackageId), ...actor(ctx),
      kind: 'repo', verb: value ? 'set the repository key' : 'cleared the repository key',
      targetLabel: wp.wp_key, from: wp.ref_key, to: value,
      detail: value ? `${wp.wp_key} is ${value} in the repository` : null,
    }, tx);
  });
  return { id: Number(workPackageId), ref_key: value };
}

/**
 * Link a work package to something in a repository, by hand.
 *
 * By id, or by kind and number — 'link WP-112 to PR 978' is how a person says
 * it. Either way the item has to already be in the mirror: inventing a row for
 * a pull request nobody has fetched would put a title-less, state-less object on
 * the screen that looks like a pull request and is a guess.
 */
async function linkWorkPackage(ctx, workPackageId, input) {
  const wp = await db.one(`
    SELECT wp.id, wp.project_id, wp.wp_key, wp.author_id, wp.assignee_id, t.git_item_kind
      FROM work_packages wp JOIN work_package_types t ON t.id = wp.type_id
     WHERE wp.id = ?`, [workPackageId]);
  if (!wp) throw notFound('no such work package');
  const perms = await access.permissionsFor(ctx.user.id, wp.project_id);
  if (!access.canEditWorkPackage(perms, wp, ctx.user.id)) {
    throw forbidden('you may not edit this work package');
  }

  let item = null;
  if (input.item_id) {
    item = await db.one(`
      SELECT gi.*, r.project_id, r.name AS repository FROM git_items gi
        JOIN repositories r ON r.id = gi.repository_id WHERE gi.id = ?`, [input.item_id]);
  } else {
    const kind = String(input.kind || 'pull_request');
    const ref = String(input.ref || '').replace(/^#/, '').trim();
    if (!ref) throw badRequest('which item — pass item_id, or kind and ref');
    const where = input.repository_id ? 'gi.repository_id = ?' : 'r.project_id = ?';
    item = await db.one(`
      SELECT gi.*, r.project_id, r.name AS repository FROM git_items gi
        JOIN repositories r ON r.id = gi.repository_id
       WHERE ${where} AND gi.kind = ? AND gi.ref = ?`,
    [input.repository_id || wp.project_id, kind, ref]);
    if (!item) {
      throw notFound(
        `${kind.replace('_', ' ')} ${ref} is not in the mirror. Pull the repository and try again — `
        + 'nothing here invents a forge object it has not seen.'
      );
    }
  }
  if (!item) throw notFound('no such item');
  if (Number(item.project_id) !== Number(wp.project_id)) {
    throw badRequest('that item belongs to a repository in another project');
  }

  const relation = String(input.relation || (wp.git_item_kind === item.kind ? 'implements' : 'mentions'));
  if (!gitdeck.RELATIONS.includes(relation)) {
    throw badRequest(`relation must be one of ${gitdeck.RELATIONS.join(', ')}`);
  }

  const existing = await db.one(
    'SELECT id, removed_at FROM work_package_git_links WHERE work_package_id = ? AND git_item_id = ? AND relation = ?',
    [workPackageId, item.id, relation]
  );
  if (existing && !existing.removed_at) throw conflict('that link already exists');

  const id = await db.transaction(async (tx) => {
    let linkId;
    if (existing) {
      // Re-linking by hand is allowed and is the only way a link a person
      // removed comes back. The puller cannot do it.
      await tx.update('work_package_git_links', existing.id, {
        removed_at: null, removed_by: null, created_by: ctx.user.id,
        actor_label: ctx.actorLabel || null, origin: 'manual', matched_in: 'manual',
      });
      linkId = Number(existing.id);
    } else {
      linkId = Number(await tx.insert('work_package_git_links', {
        work_package_id: workPackageId, git_item_id: item.id, relation,
        origin: 'manual', matched_in: 'manual', matched_key: null,
        created_by: ctx.actorLabel ? null : ctx.user.id, actor_label: ctx.actorLabel || null,
      }));
    }
    await notify.record({
      projectId: wp.project_id, workPackageId: Number(workPackageId), ...actor(ctx),
      kind: 'repo', verb: 'linked to the repository', targetLabel: wp.wp_key,
      detail: `${relation} ${item.kind.replace('_', ' ')} ${item.ref} in ${item.repository}`,
    }, tx);
    return linkId;
  });
  return { id, relation, item: { id: Number(item.id), kind: item.kind, ref: item.ref, url: item.url } };
}

/** Remove a link. The row stays, and the puller will not re-make it. */
async function unlinkWorkPackage(ctx, linkId) {
  const link = await db.one(`
    SELECT l.*, wp.project_id, wp.wp_key, wp.author_id, wp.assignee_id,
           gi.kind, gi.ref, r.name AS repository
      FROM work_package_git_links l
      JOIN work_packages wp ON wp.id = l.work_package_id
      JOIN git_items gi ON gi.id = l.git_item_id
      JOIN repositories r ON r.id = gi.repository_id
     WHERE l.id = ?`, [linkId]);
  if (!link) throw notFound('no such link');
  const perms = await access.permissionsFor(ctx.user.id, link.project_id);
  if (!access.canEditWorkPackage(perms, link, ctx.user.id)) {
    throw forbidden('you may not edit this work package');
  }
  if (link.removed_at) throw conflict('that link is already removed');

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE work_package_git_links SET removed_at = NOW(), removed_by = ? WHERE id = ?',
      [ctx.user.id, linkId]
    );
    await notify.record({
      projectId: link.project_id, workPackageId: Number(link.work_package_id), ...actor(ctx),
      kind: 'repo', verb: 'removed a repository link', targetLabel: link.wp_key,
      detail: `${link.relation} ${link.kind.replace('_', ' ')} ${link.ref} in ${link.repository}`
        + ' — the puller will not re-make this link',
    }, tx);
  });
  return { id: Number(linkId), removed: true };
}

/**
 * Override what a type maps to in one repository, and optionally what a merge
 * or a close does to it.
 *
 * The status fields are the sharp end and default to nothing: a repository that
 * has not been told to move statuses does not move them. When one is set the
 * move still goes through `status_transitions`, so this cannot be used to make
 * an illegal transition legal.
 */
async function setTypeRule(ctx, repositoryId, input) {
  const repo = await db.one('SELECT id, project_id, name FROM repositories WHERE id = ?', [repositoryId]);
  if (!repo) throw notFound('no such repository');
  await access.require(ctx.user.id, repo.project_id, 'manage_repositories');

  const type = await db.one('SELECT id, name FROM work_package_types WHERE name = ?',
    [String(input.type || '').toUpperCase()]);
  if (!type) throw badRequest(`no work package type "${input.type}"`);

  const itemKind = String(input.item_kind || 'none');
  if (!gitdeck.ITEM_KINDS.includes(itemKind)) {
    throw badRequest(`item_kind must be one of ${gitdeck.ITEM_KINDS.join(', ')}`);
  }
  const relation = String(input.relation || 'mentions');
  if (!gitdeck.RELATIONS.includes(relation)) {
    throw badRequest(`relation must be one of ${gitdeck.RELATIONS.join(', ')}`);
  }
  const prefix = input.key_prefix ? String(input.key_prefix).toUpperCase() : null;
  if (prefix && !/^[A-Z]{1,4}$/.test(prefix)) {
    throw badRequest('key_prefix is one to four letters — F, B, PH');
  }

  const statusId = async (code) => {
    if (!code) return null;
    const row = await db.one('SELECT id FROM statuses WHERE code = ?', [String(code)]);
    if (!row) throw badRequest(`no status "${code}"`);
    return Number(row.id);
  };
  const mergedStatusId = await statusId(input.merged_status);
  const closedStatusId = await statusId(input.closed_status);

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO git_type_rules (repository_id, type_id, item_kind, relation, key_prefix,
                                  merged_status_id, closed_status_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE item_kind = VALUES(item_kind), relation = VALUES(relation),
        key_prefix = VALUES(key_prefix), merged_status_id = VALUES(merged_status_id),
        closed_status_id = VALUES(closed_status_id)`,
    [repo.id, type.id, itemKind, relation, prefix, mergedStatusId, closedStatusId]);
    await notify.record({
      projectId: repo.project_id, ...actor(ctx), kind: 'repo', verb: 'changed a type mapping',
      targetLabel: repo.name,
      detail: `${type.name} maps to ${itemKind} as ${relation}`
        + (mergedStatusId ? ', and a merge moves its status' : ', and a merge changes nothing'),
    }, tx);
  });
  return { repository_id: Number(repo.id), type: type.name, item_kind: itemKind, relation };
}

module.exports = {
  createRepository, updateRepository, setRefKey, linkWorkPackage, unlinkWorkPackage, setTypeRule,
};
