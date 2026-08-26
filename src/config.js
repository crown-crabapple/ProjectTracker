/**
 * Configuration, read once from the environment.
 *
 * There is no config file and no default host. A missing database name is a
 * startup failure rather than a fallback to something plausible: the failure a
 * fallback buys you is "why is my data in the wrong schema", found weeks later.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Load .env if it exists. Deliberately minimal — KEY=value, # comments, no
 * interpolation, no quotes stripping beyond one matched pair. A dependency for
 * this is a dependency for twenty lines.
 *
 * A variable already set in the real environment always wins, so a deploy that
 * exports PT_DB_PASSWORD cannot be overridden by a stale .env left on disk.
 */
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const int = (name, fallback) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
};

const config = {
  root: ROOT,
  db: {
    host: process.env.PT_DB_HOST || '127.0.0.1',
    port: int('PT_DB_PORT', 3306),
    user: process.env.PT_DB_USER || 'root',
    password: process.env.PT_DB_PASSWORD || '',
    database: process.env.PT_DB_NAME || '',
    connectionLimit: int('PT_DB_POOL', 10),
  },
  http: {
    port: int('PT_PORT', 4180),
    host: process.env.PT_HOST || '127.0.0.1',
  },
  filesDir: path.resolve(ROOT, process.env.PT_FILES_DIR || './var/files'),
  exportsDir: path.resolve(ROOT, process.env.PT_EXPORTS_DIR || './var/exports'),
  secret: process.env.PT_SECRET || '',
  /** Set by test/selftest.js so the suite can never touch a real database. */
  isTest: process.env.PT_TEST === '1',
};

/**
 * Called by every entry point before it opens a connection. Kept separate from
 * module load so that `require('./config')` in a tool that only wants ROOT does
 * not fail on an unconfigured checkout.
 */
function requireDatabase() {
  if (!config.db.database) {
    throw new Error(
      'PT_DB_NAME is not set. Copy .env.example to .env and fill it in, or export the variables.'
    );
  }
  return config.db;
}

module.exports = { config, requireDatabase, loadDotEnv, ROOT };
