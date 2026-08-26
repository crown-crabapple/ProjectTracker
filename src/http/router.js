/**
 * A router over node:http. About a hundred lines, no dependency.
 *
 * The reason not to reach for a framework here: this app needs path parameters,
 * a JSON body, a cookie, a static handler and a file upload. That is the whole
 * list, and it is smaller than the configuration surface of anything that would
 * provide it. What a framework would genuinely buy — a middleware ecosystem — is
 * not something a single-purpose tracker draws on.
 *
 * Routes are matched in registration order. A pattern segment starting with ':'
 * captures; '*' at the end captures the rest of the path.
 */

'use strict';

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const badRequest = (m, extra) => new HttpError(400, m, extra);
const unauthorized = (m = 'sign in first') => new HttpError(401, m);
const forbidden = (m = 'not allowed') => new HttpError(403, m);
const notFound = (m = 'not found') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

function compile(pattern) {
  const parts = pattern.split('/').filter(Boolean);
  return { parts, wildcard: parts[parts.length - 1] === '*' };
}

function match(compiled, pathname) {
  const segs = pathname.split('/').filter(Boolean);
  const { parts, wildcard } = compiled;
  if (!wildcard && segs.length !== parts.length) return null;
  if (wildcard && segs.length < parts.length - 1) return null;
  const params = {};
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === '*') { params.rest = segs.slice(i).join('/'); return params; }
    if (p.startsWith(':')) {
      // A path segment is decoded once, here. Decoding it twice is how '%252e'
      // becomes '.' and a path escapes its directory.
      try { params[p.slice(1)] = decodeURIComponent(segs[i]); }
      catch { return null; }
      continue;
    }
    if (p !== segs[i]) return null;
  }
  return params;
}

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, pattern, compiled: compile(pattern), handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  put(p, h) { return this.add('PUT', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /**
   * Find a handler. Returns { handler, params } or, when the path matches but
   * the method does not, { allow } so the caller can answer 405 with an Allow
   * header rather than a misleading 404.
   */
  resolve(method, pathname) {
    const allow = new Set();
    for (const r of this.routes) {
      const params = match(r.compiled, pathname);
      if (!params) continue;
      if (r.method === method) return { handler: r.handler, params };
      allow.add(r.method);
    }
    return allow.size ? { allow: [...allow] } : null;
  }
}

module.exports = { Router, HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
