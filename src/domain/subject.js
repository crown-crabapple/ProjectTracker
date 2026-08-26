/**
 * Automatic work package subject generation.
 *
 * A pattern on the work package type, expanded against the work package's own
 * attributes: '{{type}} — {{custom.Domain}} {{subject}}'.
 *
 * Two rules, both of which exist because a generated subject that cannot be
 * corrected is worse than no generation at all:
 *
 *  1. Generation only ever fills a BLANK subject. It never overwrites text a
 *     person typed.
 *  2. An unresolved placeholder takes its adjacent separator with it, so a
 *     missing custom field leaves 'BUG — filter bar' rather than
 *     'BUG —  filter bar' or 'BUG — {{custom.Domain}} filter bar'. That is why
 *     the pattern is parsed into parts instead of being run through a regex
 *     replace: a replace cannot see that the text either side of the hole is a
 *     separator.
 */

'use strict';

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_. ]+)\s*\}\}/g;
const SEPARATOR_ONLY = /^[\s—–\-·|,]*$/;
const TRIM_SEPARATORS = /^[\s—–\-·|,]+|[\s—–\-·|,]+$/g;

/** Split a pattern into literal runs and placeholders, in order. */
function parse(pattern) {
  const parts = [];
  let last = 0;
  for (const m of pattern.matchAll(PLACEHOLDER)) {
    if (m.index > last) parts.push({ literal: pattern.slice(last, m.index) });
    parts.push({ key: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < pattern.length) parts.push({ literal: pattern.slice(last) });
  return parts;
}

function lookup(key, context) {
  const raw = key.startsWith('custom.')
    ? (context.custom || {})[key.slice('custom.'.length)]
    : context[key];
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
}

/** Expand `pattern` against `context`, or null if nothing survives. */
function expand(pattern, context) {
  if (!pattern) return null;
  const resolved = parse(pattern).map((p) => (
    p.literal !== undefined ? { literal: p.literal } : { value: lookup(p.key, context) }
  ));

  // A missing placeholder takes ONE adjacent separator with it: the one before
  // it, or the one after if it is the first part. Taking both is the mistake
  // this replaced — with '{{type}} — {{domain}} {{subject}}' and no domain, it
  // dropped the dash and the space and produced 'BUGfilter bar'.
  const keep = resolved.map(() => true);
  const separator = (i) => resolved[i] && resolved[i].literal !== undefined
    && SEPARATOR_ONLY.test(resolved[i].literal);
  resolved.forEach((p, i) => {
    if (p.literal !== undefined || p.value !== null) return;
    keep[i] = false;
    if (separator(i - 1) && keep[i - 1]) keep[i - 1] = false;
    else if (separator(i + 1) && keep[i + 1]) keep[i + 1] = false;
  });

  const out = resolved
    .filter((_, i) => keep[i])
    .map((p) => (p.literal !== undefined ? p.literal : p.value))
    .join('')
    .replace(/\s{2,}/g, ' ')
    .replace(TRIM_SEPARATORS, '')
    .trim();
  return out || null;
}

/** The subject to store. Returns a typed subject untouched. */
function resolve({ subject, pattern, context }) {
  const typed = (subject || '').trim();
  if (typed) return { subject: typed, generated: false };
  const generated = expand(pattern, context || {});
  if (generated) return { subject: generated, generated: true };
  // Neither typed nor generable. The caller turns this into a validation error
  // rather than storing an empty subject — a row with no subject is a row nobody
  // can find again.
  return { subject: null, generated: false };
}

module.exports = { expand, resolve, parse };
