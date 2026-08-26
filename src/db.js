/**
 * The database. One pool, parameterised queries only, and a small set of helpers
 * that the rest of the app is expected to use instead of reaching for the driver.
 *
 * Why mysql2 rather than the `mariadb` connector: prepared-statement support
 * (`execute`) with a stable placeholder syntax, and it is the driver every
 * MariaDB deployment guide already assumes. Either would work; this one has the
 * larger body of published answers when something goes wrong at 11pm.
 *
 * The rule this file exists to enforce: no SQL string anywhere in the app is
 * built by concatenating a value. Identifiers that genuinely have to vary
 * (a sort column, a filter field) go through `ident()`, which resolves them
 * against an allow-list and throws on anything else.
 */

'use strict';

const mysql = require('mysql2/promise');
const { config, requireDatabase } = require('./config');

let pool = null;

function getPool() {
  if (pool) return pool;
  const db = requireDatabase();
  pool = mysql.createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: db.connectionLimit,
    waitForConnections: true,
    charset: 'utf8mb4_unicode_ci',
    // Dates come back as 'YYYY-MM-DD' strings rather than Date objects. A DATE
    // turned into a JS Date acquires a timezone it never had, and then a due
    // date shifts by a day for anyone west of UTC. This is the single most
    // expensive bug in every date-handling app and one option turns it off.
    dateStrings: ['DATE', 'DATETIME'],
    // DECIMAL as a string would be correct for money; here every DECIMAL is
    // hours and is summed and displayed, so a Number is what the callers want.
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    namedPlaceholders: false,
    multipleStatements: false,
    timezone: 'Z',
  });
  return pool;
}

/** Rows for a SELECT. Always parameterised. */
async function query(sql, params = []) {
  const [rows] = await getPool().query(sql, params);
  return rows;
}

/** The first row, or null. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** A single scalar from the first row, or null. */
async function scalar(sql, params = []) {
  const row = await one(sql, params);
  if (!row) return null;
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}

/** INSERT/UPDATE/DELETE. Returns { insertId, affectedRows, changedRows }. */
async function run(sql, params = []) {
  const [result] = await getPool().query(sql, params);
  return result;
}

/**
 * Insert a row from an object. Column names come from the object's own keys and
 * are quoted as identifiers; every value is a placeholder. Returns insertId.
 */
async function insert(table, row) {
  const cols = Object.keys(row);
  if (!cols.length) throw new Error(`insert into ${table} with no columns`);
  const sql = `INSERT INTO \`${ident(table)}\` (${cols.map((c) => '`' + ident(c) + '`').join(', ')})
               VALUES (${cols.map(() => '?').join(', ')})`;
  const result = await run(sql, cols.map((c) => row[c]));
  return result.insertId;
}

/** Update by primary key id. Returns affectedRows. */
async function update(table, id, row) {
  const cols = Object.keys(row);
  if (!cols.length) return 0;
  const sql = `UPDATE \`${ident(table)}\` SET ${cols.map((c) => '`' + ident(c) + '` = ?').join(', ')} WHERE id = ?`;
  const result = await run(sql, [...cols.map((c) => row[c]), id]);
  return result.affectedRows;
}

/**
 * Run fn inside a transaction on one connection. The connection is handed to fn
 * wrapped in the same helper shape, so callers do not have to learn a second
 * API to be transactional.
 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const tx = {
      query: async (sql, params = []) => (await conn.query(sql, params))[0],
      one: async (sql, params = []) => {
        const rows = (await conn.query(sql, params))[0];
        return rows.length ? rows[0] : null;
      },
      scalar: async (sql, params = []) => {
        const rows = (await conn.query(sql, params))[0];
        if (!rows.length) return null;
        const keys = Object.keys(rows[0]);
        return keys.length ? rows[0][keys[0]] : null;
      },
      run: async (sql, params = []) => (await conn.query(sql, params))[0],
      insert: async (table, row) => {
        const cols = Object.keys(row);
        const sql = `INSERT INTO \`${ident(table)}\` (${cols.map((c) => '`' + ident(c) + '`').join(', ')})
                     VALUES (${cols.map(() => '?').join(', ')})`;
        return (await conn.query(sql, cols.map((c) => row[c])))[0].insertId;
      },
      update: async (table, id, row) => {
        const cols = Object.keys(row);
        if (!cols.length) return 0;
        const sql = `UPDATE \`${ident(table)}\` SET ${cols.map((c) => '`' + ident(c) + '` = ?').join(', ')} WHERE id = ?`;
        return (await conn.query(sql, [...cols.map((c) => row[c]), id]))[0].affectedRows;
      },
    };
    const out = await fn(tx);
    await conn.commit();
    return out;
  } catch (e) {
    try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * The only way an identifier reaches SQL. Anything outside [A-Za-z0-9_] throws
 * rather than being escaped, because there is no legitimate column in this
 * schema that needs escaping and a name that does is a name that came from a
 * request body.
 */
function ident(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`not a valid identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Read a JSON column back into a value.
 *
 * MariaDB's JSON type is LONGTEXT with a check constraint, and whether the
 * driver hands it back parsed depends on the column's reported charset. So this
 * accepts both and is the only place in the app that calls JSON.parse on a
 * column — writing `JSON.parse(row.blueprint)` at a call site is how this first
 * broke.
 */
function json(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/** `IN (?, ?, ?)` for a list, with the placeholders and values kept together. */
function inClause(values) {
  if (!values.length) return { sql: '(NULL)', params: [] };
  return { sql: `(${values.map(() => '?').join(', ')})`, params: values };
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

/** Used by the selftest to point the pool at a throwaway database. */
function reconfigure(overrides) {
  Object.assign(config.db, overrides);
  pool = null;
}

module.exports = {
  getPool, query, one, scalar, run, insert, update, transaction,
  ident, inClause, json, close, reconfigure,
};
