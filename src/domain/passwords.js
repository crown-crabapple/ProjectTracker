/**
 * Password hashing with scrypt from node:crypto.
 *
 * No dependency, because the platform already ships the right primitive. The
 * parameters below are the Node defaults with N raised to 2^15, which costs
 * about 100ms per verification on this class of machine — slow enough to matter
 * to an attacker, fast enough that a login does not feel broken.
 */

'use strict';

const crypto = require('crypto');

const N = 32768;   // 2^15
const r = 8;
const p = 1;
const KEYLEN = 64;

function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return { hash: key.toString('hex'), salt };
}

function verify(password, storedHash, salt) {
  if (!storedHash || !salt) return false;
  const key = crypto.scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  const stored = Buffer.from(storedHash, 'hex');
  // Length-check first: timingSafeEqual throws on a mismatch, and the throw
  // would itself be a timing signal.
  if (stored.length !== key.length) return false;
  return crypto.timingSafeEqual(stored, key);
}

module.exports = { hash, verify };
