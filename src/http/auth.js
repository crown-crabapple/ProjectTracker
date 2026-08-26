/**
 * Sessions.
 *
 * A random 32-byte token in an httpOnly, SameSite=Lax cookie, and a row that
 * carries its expiry. No JWT: the app has a database in front of it, so a token
 * that can be revoked by deleting a row is strictly better than one that cannot
 * be revoked at all.
 *
 * A placeholder user has no login and no password hash, so `signIn` cannot
 * authenticate one. That is the whole mechanism behind "assignable, cannot sign
 * in" — there is nothing to check rather than a check that says no.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const passwords = require('../domain/passwords');
const { unauthorized, badRequest } = require('./router');

const COOKIE = 'pt_session';
const TTL_DAYS = 14;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookieHeader(token, { clear = false, secure = false } = {}) {
  const bits = [
    `${COOKIE}=${clear ? '' : token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${TTL_DAYS * 86400}`,
  ];
  // Secure is set from the request's own scheme rather than always: a cookie
  // marked Secure over plain http on a loopback dev server is a cookie the
  // browser silently drops, and the symptom is "login does nothing".
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

async function signIn(login, password, userAgent) {
  const user = await db.one(
    'SELECT id, login, password_hash, password_salt, active, kind FROM users WHERE login = ?', [login]
  );
  // One message for every failure. Distinguishing "no such user" from "wrong
  // password" is a way to enumerate accounts.
  const fail = () => unauthorized('that login and password do not match');
  if (!user || !user.active || user.kind !== 'user') throw fail();
  if (!passwords.verify(password, user.password_hash, user.password_salt)) throw fail();

  const token = crypto.randomBytes(32).toString('hex');
  await db.insert('sessions', {
    token,
    user_id: user.id,
    expires_at: new Date(Date.now() + TTL_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' '),
    user_agent: (userAgent || '').slice(0, 255),
  });
  await db.run('UPDATE users SET last_seen_at = NOW() WHERE id = ?', [user.id]);
  return { token, userId: user.id };
}

async function signOut(token) {
  if (token) await db.run('DELETE FROM sessions WHERE token = ?', [token]);
}

/**
 * The signed-in user for a request, or null. Expired sessions are deleted.
 *
 * The token is deliberately NOT part of what comes back. It is in an httpOnly
 * cookie, and handing it to page script as well would give up the one property
 * httpOnly buys.
 */
async function currentUser(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = await db.one(`
    SELECT s.token, s.expires_at, u.*
      FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`, [token]);
  if (!row) return null;
  if (new Date(String(row.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
    await db.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  if (!row.active) return null;
  return {
    id: row.id, login: row.login, name: row.name, initials: row.initials, colour: row.colour,
    email: row.email, is_admin: Boolean(row.is_admin), kind: row.kind,
    weekly_capacity: Number(row.weekly_capacity),
    highlight_mode: row.highlight_mode, start_screen: row.start_screen,
    show_ai_summaries: Boolean(row.show_ai_summaries),
    theme_id: row.theme_id, timezone: row.timezone,
  };
}

/** Prune expired sessions. Called on startup and hourly. */
async function pruneSessions() {
  const r = await db.run('DELETE FROM sessions WHERE expires_at < NOW()');
  return r.affectedRows;
}

/**
 * A share token: read access to one work package by link, with no account.
 *
 * Returns the share row plus the work package's project, or throws. Every check
 * is here — malformed, revoked, expired — so a caller cannot use a share and
 * forget one of them.
 */
async function shareFor(token) {
  // The alphabet is the one src/api/mutations.js mints from, and the check runs
  // before any lookup so a path like '../../etc/passwd' never reaches a query.
  if (!token || !/^[A-Za-z0-9]{8,48}$/.test(token)) throw badRequest('not a share token');
  const share = await db.one(`
    SELECT s.*, wp.project_id FROM work_package_shares s
      JOIN work_packages wp ON wp.id = s.work_package_id
     WHERE s.token = ?`, [token]);
  if (!share) throw unauthorized('that link is not valid');
  if (share.revoked_at) throw unauthorized('that link has been revoked');
  if (share.expires_at && new Date(String(share.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
    throw unauthorized('that link has expired');
  }
  await db.run(
    'UPDATE work_package_shares SET view_count = view_count + 1, last_viewed_at = NOW() WHERE id = ?', [share.id]
  );
  return share;
}

module.exports = {
  COOKIE, TTL_DAYS, parseCookies, cookieHeader, signIn, signOut, currentUser, pruneSessions, shareFor,
};
