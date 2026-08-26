#!/usr/bin/env node
/**
 * Create the database if it is absent, apply db/schema.sql to an empty one, then
 * apply any db/migrations/NNNN_*.sql that have not run yet.
 *
 *   node db/migrate.js             apply what is pending
 *   node db/migrate.js --force     DROP the database first (asks, unless --yes)
 *   node db/migrate.js --status    what would run, and what already has
 *   node db/migrate.js --no-login  do not create the default login
 *
 * schema.sql is the base and is only ever applied to an empty schema. Once a
 * database exists, changes arrive as numbered migrations — editing schema.sql to
 * change a live table is the mistake this split exists to make impossible.
 *
 * It also leaves behind one account that can sign in, so a migrated database is
 * usable without seeding the demo portfolio. See ensureDefaultLogin below.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { config, requireDatabase } = require('../src/config');
const passwords = require('../src/domain/passwords');

const SCHEMA = path.join(__dirname, 'schema.sql');
const MIGRATIONS = path.join(__dirname, 'migrations');

const DEFAULT_LOGIN = 'admin';
const DEFAULT_NAME = 'Administrator';
// A login is a name somebody types at a keyboard: the alphabet db.ident() allows
// a column, plus the dot and dash people put in usernames. Anything outside it
// arrived from a copy-paste accident rather than from a decision.
const LOGIN_SHAPE = /^[A-Za-z0-9._-]{1,80}$/;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

/**
 * Split a .sql file into statements. Deliberately small: it handles line
 * comments, block comments, and single/double-quoted strings, which is
 * everything this project's SQL contains. It does not handle DELIMITER, so
 * triggers and procedures are out — and that is a constraint worth having,
 * because logic in the database is logic the tests cannot reach.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let quote = null;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (quote) {
      buf += c;
      if (c === '\\') { buf += next || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; i += 1; continue; }
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === ';') { if (buf.trim()) out.push(buf.trim()); buf = ''; i += 1; continue; }
    buf += c;
    i += 1;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function ask(question) {
  if (has('--yes')) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function pendingFiles(applied) {
  if (!fs.existsSync(MIGRATIONS)) return [];
  return fs.readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .filter((f) => !applied.has(f));
}

/**
 * A password nobody chose, in an alphabet nobody has to squint at.
 *
 * The 32 characters exclude 0/o, 1/l and anything else that is ambiguous read
 * off a terminal, so the string can be typed into a login box from a scrollback
 * without a second attempt. 32 divides 256, so `byte % 32` is uniform and no
 * character is likelier than another. Four groups of five is 100 bits.
 */
function generatePassword() {
  const alphabet = '123456789abcdefghjkmnpqrstuvwxyz';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    if (i > 0 && i % 5 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Up to two initials from a name, because the column is NOT NULL. */
function initialsOf(name) {
  const letters = name.trim().split(/\s+/).map((w) => w[0]).filter(Boolean);
  return (letters.slice(0, 2).join('') || '??').toUpperCase().slice(0, 4);
}

/**
 * Whether any account in this database can sign in at all.
 *
 * `signIn` refuses an inactive account, a placeholder and a system actor, so
 * those do not count: a database whose only account is deactivated is a database
 * nobody can get into, and minting a login for it is the point of this function
 * rather than a hole in it — whoever runs migrate already holds the database
 * credentials.
 */
async function signInCapable(conn) {
  const [rows] = await conn.query(
    `SELECT login FROM users
      WHERE kind = 'user' AND active = 1 AND password_hash IS NOT NULL AND login IS NOT NULL
      ORDER BY id LIMIT 1`
  );
  return rows.length ? rows[0].login : null;
}

async function hasUsersTable(conn, database) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = ? AND table_name = 'users'`, [database]
  );
  return Number(rows[0].n) > 0;
}

/** The one line --status prints about signing in. */
async function loginStatus(conn, database) {
  const present = await hasUsersTable(conn, database);
  const canSignIn = present ? await signInCapable(conn) : null;
  if (canSignIn) return `${canSignIn} can sign in`;
  if (has('--no-login')) return 'nothing can sign in';
  const wanted = (process.env.PT_ADMIN_LOGIN || DEFAULT_LOGIN).trim();
  if (present) {
    const [taken] = await conn.query('SELECT id FROM users WHERE login = ?', [wanted]);
    // Saying "one would be created" when the name is taken would be a status
    // line that lies, and the run below is the thing it is describing.
    if (taken.length) return `nothing can sign in — "${wanted}" is taken, so none would be created`;
  }
  return `nothing can sign in — "${wanted}" would be created`;
}

/**
 * Leave behind exactly one account that can sign in, so that migrate plus
 * `seed.js --reference` is a working install and the demo portfolio stays
 * optional. Seeding the demo used to be the only way to get a login, which made
 * "try it" and "start using it" the same command.
 *
 * Three properties worth stating, because each is the answer to a question:
 *
 * - It runs only when nothing can sign in, so it is safe on every re-run and on
 *   a live database. It never touches an account that already exists — a
 *   password reset from a schema tool is a password reset nobody asked for.
 * - The password comes from PT_ADMIN_PASSWORD if it is set, and is otherwise
 *   generated and printed once. There is no built-in default: a shipped
 *   admin/admin is a credential in the source tree, which is the thing the rest
 *   of this project refuses to have.
 * - theme_id is left NULL. The bootstrap falls back to the default theme, so
 *   this does not quietly depend on reference data being seeded first.
 */
async function ensureDefaultLogin(conn, database) {
  if (has('--no-login')) return;
  if (!await hasUsersTable(conn, database)) {
    console.log('! there is no users table yet — no login was created');
    return;
  }
  if (await signInCapable(conn)) return;

  const login = (process.env.PT_ADMIN_LOGIN || DEFAULT_LOGIN).trim();
  if (!LOGIN_SHAPE.test(login)) {
    throw new Error(`PT_ADMIN_LOGIN "${login}" is not a login: letters, digits, dot, dash and underscore, up to 80 characters`);
  }

  const [taken] = await conn.query(
    'SELECT kind, active, password_hash IS NOT NULL AS has_password FROM users WHERE login = ?', [login]
  );
  if (taken.length) {
    const row = taken[0];
    const why = [
      `kind ${row.kind}`,
      row.active ? 'active' : 'deactivated',
      Number(row.has_password) ? 'has a password' : 'has no password',
    ].join(', ');
    console.log(`! the login "${login}" already exists and cannot sign in (${why}) — no login was created`);
    console.log('  Fix that account deliberately, or set PT_ADMIN_LOGIN to a name that is free.');
    return;
  }

  const name = (process.env.PT_ADMIN_NAME || DEFAULT_NAME).trim() || DEFAULT_NAME;
  const email = (process.env.PT_ADMIN_EMAIL || '').trim() || null;
  const supplied = process.env.PT_ADMIN_PASSWORD || '';
  const password = supplied || generatePassword();
  const { hash, salt } = passwords.hash(password);

  await conn.query(
    `INSERT INTO users (login, name, email, initials, kind, password_hash, password_salt,
                        is_admin, timezone, start_screen)
     VALUES (?, ?, ?, ?, 'user', ?, ?, 1, 'UTC', 'my')`,
    [login, name, email, initialsOf(name), hash, salt]
  );

  console.log(`created the default login ${login} — an administrator, in no project`);
  if (supplied) {
    console.log('  password: the one in PT_ADMIN_PASSWORD');
  } else {
    console.log('');
    console.log('  Password (shown once, not recoverable from the database):');
    console.log(`    ${password}`);
    console.log('');
    console.log('  Set PT_ADMIN_PASSWORD before migrating to choose it yourself.');
  }

  // The account is not enough on its own: with no statuses there is no progress
  // model, and the app fails on its first query. Only worth saying when it is
  // true, and a half-migrated schema with no statuses table is not this hint's
  // problem to report.
  try {
    const [statuses] = await conn.query('SELECT COUNT(*) AS n FROM statuses');
    if (!Number(statuses[0].n)) {
      console.log('  Next: node db/seed.js --reference   (statuses, roles, the work week — the app needs them)');
    }
  } catch { /* no statuses table: migrate said what it applied, which is the report that matters */ }
}

async function main() {
  const db = requireDatabase();

  // Connect without a database first: the schema may not exist yet.
  const admin = await mysql.createConnection({
    host: db.host, port: db.port, user: db.user, password: db.password, multipleStatements: false,
  });

  if (has('--force')) {
    const ok = await ask(`DROP DATABASE \`${db.database}\` and everything in it? [y/N] `);
    if (!ok) { console.log('nothing done'); await admin.end(); process.exit(1); }
    await admin.query(`DROP DATABASE IF EXISTS \`${db.database}\``);
    console.log(`dropped ${db.database}`);
  }

  await admin.query(
    `CREATE DATABASE IF NOT EXISTS \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await admin.changeUser({ database: db.database });

  await admin.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   VARCHAR(190) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    statements INT NOT NULL DEFAULT 0,
    PRIMARY KEY (filename)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const [rows] = await admin.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const [tables] = await admin.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [db.database]
  );
  // schema_migrations itself is the one table an "empty" database may have.
  const empty = Number(tables[0].n) <= 1;

  const plan = [];
  if (!applied.has('schema.sql')) {
    if (empty) plan.push(['schema.sql', SCHEMA]);
    else console.log('! schema.sql is not recorded but the database is not empty — skipping the base');
  }
  for (const f of pendingFiles(applied)) plan.push([f, path.join(MIGRATIONS, f)]);

  if (has('--status')) {
    console.log(`database   ${db.database} @ ${db.host}:${db.port}`);
    console.log(`applied    ${applied.size ? [...applied].join(', ') : 'nothing'}`);
    console.log(`pending    ${plan.length ? plan.map((p) => p[0]).join(', ') : 'nothing'}`);
    console.log(`login      ${await loginStatus(admin, db.database)}`);
    await admin.end();
    return;
  }

  if (!plan.length) {
    console.log(`up to date — ${applied.size} migration(s) applied to ${db.database}`);
    // Still checked: a database migrated before this existed has no login either.
    await ensureDefaultLogin(admin, db.database);
    await admin.end();
    return;
  }

  for (const [name, file] of plan) {
    const statements = splitStatements(fs.readFileSync(file, 'utf8'));
    for (const stmt of statements) {
      try {
        await admin.query(stmt);
      } catch (e) {
        console.error(`\n${name} failed on:\n${stmt.slice(0, 400)}\n`);
        throw e;
      }
    }
    await admin.query(
      'INSERT INTO schema_migrations (filename, statements) VALUES (?, ?)', [name, statements.length]
    );
    console.log(`applied ${name}  (${statements.length} statements)`);
  }

  const [after] = await admin.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [db.database]
  );
  console.log(`${db.database} now has ${after[0].n} tables`);
  await ensureDefaultLogin(admin, db.database);
  await admin.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
