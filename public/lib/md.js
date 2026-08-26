/*
 * A small markdown renderer.
 *
 * It builds DOM nodes rather than an HTML string, which is the whole reason it
 * exists instead of a library: the wiki renders text people typed, and a
 * renderer that produces a string is one innerHTML away from executing it. There
 * is no innerHTML in this file and no `new Function`, so a document containing a
 * script tag renders as the words "script tag".
 *
 * What it supports, which is what the wiki uses: ATX headings, paragraphs,
 * fenced code, blockquotes, unordered and ordered lists, pipe tables, horizontal
 * rules, and inline bold / italic / code / links. Anything else renders as the
 * literal text, which is the honest failure: the author sees their markup and
 * knows it did not take.
 */

(function (global) {
  'use strict';

  const { h } = global.dom;

  /** Inline: **bold**, *italic*, `code`, [text](url). */
  function inline(text) {
    const out = [];
    const pattern = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))/g;
    let last = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const token = m[0];
      if (token.startsWith('**')) out.push(h('b', { text: token.slice(2, -2) }));
      else if (token.startsWith('`')) out.push(h('code', { text: token.slice(1, -1) }));
      else if (token.startsWith('[')) {
        const split = token.indexOf('](');
        const label = token.slice(1, split);
        const href = token.slice(split + 2, -1);
        // Only http(s), mailto and in-app links. A javascript: or data: href is
        // rendered as plain text, because a wiki page is text somebody typed.
        const safe = /^(https?:\/\/|mailto:|\/|#)/i.test(href);
        out.push(safe
          ? h('a', { href, rel: 'noopener noreferrer', text: label })
          : `${label} (${href})`);
      } else out.push(h('i', { text: token.slice(1, -1) }));
      last = pattern.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function splitRow(line) {
    return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  }

  function render(source) {
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const nodes = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i += 1; continue; }

      // Fenced code. The fence's own info string is ignored: there is no
      // highlighter here, and pretending to know the language would imply one.
      if (/^```/.test(line)) {
        const buf = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1;
        nodes.push(h('pre', [h('code', { text: buf.join('\n') })]));
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const level = Math.min(6, heading[1].length);
        nodes.push(h(`h${level}`, inline(heading[2])));
        i += 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { nodes.push(h('hr')); i += 1; continue; }

      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i += 1; }
        nodes.push(h('blockquote', [h('p', inline(buf.join(' ')))]));
        continue;
      }

      // A pipe table needs its separator row to be a table at all; without it
      // the line is a paragraph that happens to contain pipes.
      if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        const head = splitRow(line);
        i += 2;
        const body = [];
        while (i < lines.length && lines[i].includes('|')) { body.push(splitRow(lines[i])); i += 1; }
        nodes.push(h('table', [
          h('thead', [h('tr', head.map((c) => h('th', inline(c))))]),
          h('tbody', body.map((r) => h('tr', r.map((c) => h('td', inline(c)))))),
        ]));
        continue;
      }

      const bullet = /^\s*[-*+]\s+/;
      const numbered = /^\s*\d+[.)]\s+/;
      if (bullet.test(line) || numbered.test(line)) {
        const ordered = numbered.test(line);
        const items = [];
        while (i < lines.length && (bullet.test(lines[i]) || numbered.test(lines[i]))) {
          items.push(lines[i].replace(ordered ? numbered : bullet, ''));
          i += 1;
        }
        nodes.push(h(ordered ? 'ol' : 'ul', items.map((t) => h('li', inline(t)))));
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      nodes.push(h('p', inline(para.join(' '))));
    }

    return nodes;
  }

  /** The first paragraph, as plain text. Used for summaries. */
  function excerpt(source, limit = 200) {
    const text = String(source || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/^#{1,6}\s+.*$/gm, ' ')
      .replace(/[*`>|#\-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  global.md = { render, inline, excerpt };
}(window));
