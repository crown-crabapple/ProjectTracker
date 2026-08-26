#!/usr/bin/env node
/**
 * Create the database if it is absent, apply db/schema.sql to an empty one, then
 * apply any db/migrations/NNNN_*.sql that have not run yet.
 *
 *   node db/migrate.js            apply what is pending
 *   node db/migrate.js --force    DROP the database first (asks, unless --yes)
 *   node db/migrate.js --status   what would run, and what already has
 *
 * schema.sql is the base and is only ever applied to an empty schema. Once a
 * database exists, changes arrive as numbered migrations — editing schema.sql to
 * change a live table is the mistake this split exists to make impossible.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');
const { config, requireDatabase } = require('../src/config');

const SCHEMA = path.join(__dirname, 'schema.sql');
const MIGRATIONS = path.join(__dirname, 'migrations');

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
    await admin.end();
    return;
  }

  if (!plan.length) {
    console.log(`up to date — ${applied.size} migration(s) applied to ${db.database}`);
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
  await admin.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
