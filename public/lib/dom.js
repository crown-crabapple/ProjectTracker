/*
 * A tiny DOM builder, and the reason there is no framework here.
 *
 * This app renders sixteen views over data it fetches whole. Every view is a
 * pure function from a JSON payload to an element tree; none of them needs
 * incremental diffing, because none of them is ever partially updated — a change
 * refetches its view. That is the entire requirement, and `h()` below is the
 * entire implementation of it.
 *
 * The property that matters more than brevity: `h()` sets text through
 * textContent and attributes through setAttribute. There is no innerHTML path,
 * so a work package subject containing a script tag is text, in every one of the
 * sixteen views, without anybody having to remember to escape it. The single
 * exception is the markdown renderer, which builds its own nodes the same way.
 */

(function (global) {
  'use strict';

  /**
   * h('div.panel', { onclick: f }, [child, 'text'])
   *
   * The tag string carries an optional '.class.class' suffix, because a class
   * list is what nine out of ten calls actually need and spelling it as an
   * attribute doubles the length of every line.
   */
  function h(spec, props, children) {
    const parts = String(spec).split('.');
    const el = document.createElement(parts[0] || 'div');
    for (let i = 1; i < parts.length; i += 1) if (parts[i]) el.classList.add(parts[i]);

    if (props && (Array.isArray(props) || typeof props === 'string' || props instanceof Node)) {
      children = props;
      props = null;
    }

    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'style' && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            if (v !== null && v !== undefined && v !== false) el.style.setProperty(k, String(v));
          }
        } else if (key === 'class') {
          for (const c of String(value).split(/\s+/)) if (c) el.classList.add(c);
        } else if (key === 'dataset') {
          Object.assign(el.dataset, value);
        } else if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2), value);
        } else if (key === 'text') {
          el.textContent = value === true ? '' : String(value);
        } else if (value === true) {
          el.setAttribute(key, '');
        } else {
          el.setAttribute(key, String(value));
        }
      }
    }

    append(el, children);
    return el;
  }

  /**
   * The same builder, in the SVG namespace: svgEl('line', { x1: 0, ... }).
   *
   * Two views draw graphs — what blocks what, and which decisions gate which —
   * and a diagonal line is the one thing a positioned div cannot be. This
   * exists so those two do not reach for innerHTML to get one.
   *
   * It keeps h()'s discipline exactly: text through textContent, everything
   * else through setAttribute. There is no HTML-string path here either, so a
   * work package subject in an SVG label is text for the same reason it is
   * text everywhere else. The differences from h() are the two the namespace
   * forces — createElementNS, and classList through setAttribute because an
   * SVG element's className is not a string.
   */
  function svgEl(spec, props, children) {
    const parts = String(spec).split('.');
    const el = document.createElementNS('http://www.w3.org/2000/svg', parts[0] || 'g');
    const classes = parts.slice(1).filter(Boolean);

    if (props && (Array.isArray(props) || typeof props === 'string' || props instanceof Node)) {
      children = props;
      props = null;
    }

    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') { classes.push(...String(value).split(/\s+/).filter(Boolean)); continue; }
        if (key === 'text') { el.textContent = value === true ? '' : String(value); continue; }
        if (key.startsWith('on') && typeof value === 'function') {
          el.addEventListener(key.slice(2), value);
          continue;
        }
        if (key === 'style' && typeof value === 'object') {
          for (const [k, v] of Object.entries(value)) {
            if (v !== null && v !== undefined && v !== false) el.style.setProperty(k, String(v));
          }
          continue;
        }
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    if (classes.length) el.setAttribute('class', classes.join(' '));

    append(el, children);
    return el;
  }

  function append(el, children) {
    if (children === null || children === undefined || children === false) return;
    if (Array.isArray(children)) {
      for (const c of children) append(el, c);
      return;
    }
    if (children instanceof Node) { el.appendChild(children); return; }
    el.appendChild(document.createTextNode(String(children)));
  }

  /** Replace an element's contents. */
  function fill(el, children) {
    el.textContent = '';
    append(el, children);
    return el;
  }

  const $ = (sel, root) => (root || document).querySelector(sel);

  /** A percentage as a CSS width, clamped. A negative width silently renders as
   *  zero, which hides a sign error; clamping makes it visible as a full bar. */
  const pct = (n) => `${Math.max(0, Math.min(100, Number(n) || 0))}%`;

  /** A number for display: an integer stays an integer, 3.50 becomes 3.5. */
  function nf(n, fallback = '—') {
    if (n === null || n === undefined || n === '') return fallback;
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  /** '2026-08-26' -> '26 AUG'. Mirrors the server's shortDate exactly. */
  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function shortDate(iso, fallback = '—') {
    if (!iso || typeof iso !== 'string') return fallback;
    const p = iso.split('-');
    if (p.length !== 3) return fallback;
    return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]}`;
  }

  /** The label + big number + subtitle block the design uses in every KPI strip. */
  function kpi(label, value, sub, tone) {
    return h('div.kpi', [
      h('div.label', { text: label }),
      h('div.big' + (tone ? '.' + tone : ''), { text: value }),
      sub ? h('div.sub', { text: sub }) : null,
    ]);
  }

  /** A meter with its value to the right. */
  function meter(percent, colour, valueText, opts) {
    return h('div.meter-row', [
      h('div.meter' + ((opts && opts.thin) ? '.thin' : ''), [
        h('i', { style: { width: pct(percent), background: colour || 'var(--accent)' } }),
      ]),
      valueText === undefined ? null : h('span.value', { text: valueText }),
    ]);
  }

  /** The status/priority tag, coloured from the server's own colour value. */
  function tag(text, colour, small) {
    return h('span.tag' + (small ? '.small' : ''), { style: { color: colour || 'var(--ink-4)' }, text });
  }

  const key = (text) => h('span.key', { text });

  function avatar(person, opts) {
    return h('div.avatar' + ((opts && opts.big) ? '.big' : ''), {
      style: { color: person.colour || 'var(--ink-3)' },
      title: person.name || '',
      text: person.initials || '??',
    });
  }

  global.dom = { h, svgEl, fill, append, $, pct, nf, shortDate, kpi, meter, tag, key, avatar, MONTHS };
}(window));
