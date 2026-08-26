/**
 * Reading a request body: JSON, form-encoded, and multipart file uploads.
 *
 * The multipart parser is here rather than from a package because it is the one
 * place a dependency would have earned its keep and the trade did not come out
 * that way: forty lines of buffer scanning against a package with its own
 * temp-file handling, its own limits, and its own history of path-traversal
 * advisories. This one writes nothing to disk — it hands the caller buffers and
 * lets src/domain/files.js decide where bytes go, which is the part worth
 * controlling.
 */

'use strict';

const { badRequest } = require('./router');

const MAX_JSON = 1024 * 1024;             // 1 MB
const MAX_UPLOAD = 32 * 1024 * 1024;      // 32 MB per request

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        // Destroy rather than keep buffering: a client that ignores the limit
        // should not be able to hold memory open by continuing to send.
        req.destroy();
        reject(badRequest(`body larger than ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function json(req) {
  const buf = await readRaw(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (e) {
    throw badRequest(`body is not valid JSON: ${e.message}`);
  }
}

async function form(req) {
  const buf = await readRaw(req, MAX_JSON);
  const out = {};
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) out[k] = v;
  return out;
}

/** The boundary from a multipart content-type, or null. */
function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return m ? (m[1] || m[2]).trim() : null;
}

/**
 * Parse multipart/form-data into { fields, files }.
 *
 * files[] carry { field, filename, contentType, buffer }. The filename is
 * returned exactly as sent, including any directory separators, and is NOT
 * sanitised here — sanitising is the storage layer's job and doing it in two
 * places means one of them will be the lenient one.
 */
async function multipart(req) {
  const boundary = boundaryOf(req.headers['content-type']);
  if (!boundary) throw badRequest('multipart body with no boundary');
  const body = await readRaw(req, MAX_UPLOAD);
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let pos = body.indexOf(delim);
  if (pos < 0) throw badRequest('multipart body with no opening boundary');
  pos += delim.length;

  while (pos < body.length) {
    // '--' straight after a boundary is the end of the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    // Skip the CRLF after the boundary.
    while (pos < body.length && (body[pos] === 0x0d || body[pos] === 0x0a)) pos += 1;

    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headerText = body.slice(pos, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;

    let next = body.indexOf(delim, bodyStart);
    if (next < 0) next = body.length;
    // The two bytes before the next boundary are the CRLF that belongs to the
    // delimiter, not to the part.
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);
    const field = nameMatch ? nameMatch[1] : null;
    const content = body.slice(bodyStart, end);

    if (field) {
      if (fileMatch && fileMatch[1]) {
        files.push({
          field,
          filename: fileMatch[1],
          contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          buffer: content,
        });
      } else {
        fields[field] = content.toString('utf8');
      }
    }
    pos = next + delim.length;
  }
  return { fields, files };
}

/** Dispatch on content-type. */
async function read(req) {
  const type = String(req.headers['content-type'] || '');
  if (type.includes('multipart/form-data')) return { ...(await multipart(req)), kind: 'multipart' };
  if (type.includes('application/x-www-form-urlencoded')) return { fields: await form(req), files: [], kind: 'form' };
  return { fields: await json(req), files: [], kind: 'json' };
}

module.exports = { read, json, form, multipart, boundaryOf, MAX_JSON, MAX_UPLOAD };
