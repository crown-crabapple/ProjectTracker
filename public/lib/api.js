/*
 * The fetch wrapper.
 *
 * Three jobs, and each exists because of a specific failure:
 *
 *  1. It turns a non-2xx response into a thrown Error carrying the server's own
 *     message. The API always answers with { error } on a failure, and showing
 *     that sentence is the whole point of writing it — a generic "request
 *     failed" toast makes every one of them useless.
 *
 *  2. It signals 401 separately, so the shell can show the sign-in card instead
 *     of a toast. A session that expires mid-session is normal, not an error.
 *
 *  3. It cancels a superseded GET. Typing in the filter box fires a request per
 *     keystroke and the replies can arrive out of order; without the abort, the
 *     list shows the results for a prefix of what is in the box.
 */

(function (global) {
  'use strict';

  const inflight = new Map();

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.status = status;
      this.payload = payload || {};
    }
  }

  async function request(method, path, body, opts) {
    const options = opts || {};
    const init = {
      method,
      headers: {},
      // Same-origin only. The app is served from the same host as the API, and
      // 'omit' would drop the session cookie.
      credentials: 'same-origin',
    };
    if (body !== undefined && body !== null) {
      if (body instanceof FormData) {
        init.body = body;
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    // One in-flight request per key. A second one aborts the first.
    const dedupeKey = options.key || (method === 'GET' ? path.split('?')[0] : null);
    if (dedupeKey) {
      const previous = inflight.get(dedupeKey);
      if (previous) previous.abort();
      const controller = new AbortController();
      inflight.set(dedupeKey, controller);
      init.signal = controller.signal;
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (e.name === 'AbortError') {
        // A superseded request. The caller must not render anything for it, and
        // must not show an error either.
        const abort = new ApiError('superseded', 0);
        abort.superseded = true;
        throw abort;
      }
      throw new ApiError('cannot reach the server', 0);
    } finally {
      if (dedupeKey && inflight.get(dedupeKey) && inflight.get(dedupeKey).signal === init.signal) {
        inflight.delete(dedupeKey);
      }
    }

    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      if (!res.ok) throw new ApiError(`server said ${res.status}`, res.status);
      return res;
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(payload.error || `server said ${res.status}`, res.status, payload);
    return payload;
  }

  global.api = {
    ApiError,
    get: (path, opts) => request('GET', path, null, opts),
    post: (path, body, opts) => request('POST', path, body === undefined ? {} : body, opts),
    patch: (path, body, opts) => request('PATCH', path, body, opts),
    del: (path, opts) => request('DELETE', path, null, opts),
    /** Build a query string, dropping empties so a URL never carries '?x='. */
    qs(params) {
      const out = new URLSearchParams();
      for (const [k, v] of Object.entries(params || {})) {
        if (v === null || v === undefined || v === '' || v === false) continue;
        out.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
      const s = out.toString();
      return s ? `?${s}` : '';
    },
  };
}(window));
