/**
 * Attachment storage.
 *
 * Bytes are content-addressed: the path is the sha256 of the content, split two
 * levels deep so no directory holds a hundred thousand entries. Two identical
 * uploads share one file and keep two rows, so deleting one attachment can never
 * take the other's bytes.
 *
 * The filename a client sends is never used as a path. It is stored as a label
 * and nothing else — that is the only defence against traversal that does not
 * depend on getting an escaping rule right.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { config } = require('../config');
const db = require('../db');
const { badRequest, notFound } = require('../http/router');

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Types the browser may render in place. An allow-list rather than a deny-list,
 * because a deny-list is a list of the attacks somebody thought of.
 *
 * Anything not listed is stored as application/octet-stream and served with
 * Content-Disposition: attachment, so an unknown type is downloadable but never
 * interpreted. image/svg+xml is deliberately NOT on this list: an SVG is a
 * document that can carry script, and serving one inline from the same origin as
 * the app is a stored cross-site scripting hole.
 */
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain', 'text/markdown', 'text/csv',
]);

/** Control characters and the separators that could make a filename a path. */
const UNSAFE_IN_LABEL = /[\u0000-\u001f\u007f]/g;

/** Strip everything that could make a filename a path. Label use only. */
function safeLabel(filename) {
  const base = String(filename || 'file').split(/[\\/]/).pop();
  // Control characters out: a newline in a filename becomes a header injection
  // the moment it reaches Content-Disposition.
  const cleaned = base.replace(UNSAFE_IN_LABEL, '').replace(/"/g, '').trim();
  return (cleaned || 'file').slice(0, 200);
}

function pathFor(digest) {
  return path.join(config.filesDir, digest.slice(0, 2), digest.slice(2, 4), digest);
}

async function store({ buffer, filename, contentType, containerType, containerId, authorId, description = null }) {
  if (!buffer || !buffer.length) throw badRequest('that file is empty');
  if (buffer.length > MAX_BYTES) throw badRequest(`files are limited to ${Math.round(MAX_BYTES / 1048576)} MB`);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const target = pathFor(digest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Written only if absent: an existing file with this digest has, by
  // definition, these bytes.
  if (!fs.existsSync(target)) {
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  }
  const label = safeLabel(filename);
  const declared = String(contentType || '').split(';')[0].trim().toLowerCase();
  const id = await db.insert('attachments', {
    container_type: containerType,
    container_id: containerId,
    filename: label,
    content_type: INLINE_TYPES.has(declared) ? declared : 'application/octet-stream',
    byte_size: buffer.length,
    digest,
    storage_path: path.relative(config.root, target),
    description,
    author_id: authorId || null,
  });
  return { id, filename: label, byte_size: buffer.length, digest };
}

async function read(id) {
  const row = await db.one('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!row) throw notFound('no such attachment');
  const file = pathFor(row.digest);
  if (!fs.existsSync(file)) {
    // The row outliving its bytes is a real state — a restored database against
    // an unrestored file store — and saying so is more useful than a bare 404.
    throw notFound(`the bytes for "${row.filename}" are missing from the file store`);
  }
  return { row, buffer: fs.readFileSync(file) };
}

/**
 * Delete an attachment row. The bytes stay unless no other row references the
 * digest, which is the whole point of content addressing.
 */
async function remove(id) {
  const row = await db.one('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!row) throw notFound('no such attachment');
  await db.run('DELETE FROM attachments WHERE id = ?', [id]);
  const others = Number(await db.scalar('SELECT COUNT(*) FROM attachments WHERE digest = ?', [row.digest]));
  if (others === 0) {
    const file = pathFor(row.digest);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  return { removedBytes: others === 0 };
}

/** How the browser should be told to handle it. */
const disposition = (row) => (INLINE_TYPES.has(row.content_type) ? 'inline' : 'attachment');

module.exports = {
  store, read, remove, safeLabel, pathFor, disposition, INLINE_TYPES, MAX_BYTES, UNSAFE_IN_LABEL,
};
