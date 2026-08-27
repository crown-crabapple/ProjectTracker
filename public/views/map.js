/*
 * The map: one project drawn three ways.
 *
 * TREE      — the work breakdown, collapsed, optionally grouped above itself.
 * RELATIONS — what has to happen before what.
 * DECISIONS — which decisions gate which, and which work each one holds up.
 *
 * NOTHING HERE COMPUTES A NUMBER. Every percentage and count arrives from
 * `/api/map`, which gets them from `rollup.js`. Every rank arrives already
 * layered by `src/domain/graph.js`. This file turns a payload into elements and
 * does arithmetic only on pixels.
 *
 * READINESS AND COMPLETION ARE DRAWN SIDE BY SIDE, never added, at every level
 * that shows either. The bar always carries the word WEIGHTED, because a bar
 * with a percentage on it reads as "this much is finished" to everybody who has
 * not read the model.
 *
 * RUST IS RESERVED, and two things here earn it: an open decision that is
 * blocking live work (the rule `#/decisions` uses, imported from there rather
 * than restated), and a relation that closes a loop. A loop is not decoration
 * and not lateness — `scheduling.derive` cannot converge on it, so a person has
 * to decide which link to cut. Nothing else on this screen uses it.
 *
 * IT IS READ-ONLY. Every node links out: a work package to the drawer, a
 * decision to `#/decisions`. There is no write path here on purpose —
 * `docs/decisions/0011`.
 *
 * THE GRAPHS ARE DRAWN TWICE. Once as SVG and once as a nested list, with CSS
 * choosing between them at 860px. Rendering both costs a little and means a
 * resize needs no refetch; a graph you have to drag around on a phone is not a
 * picture, it is a chore, and the work table already becomes cards at 560px for
 * the same reason.
 */

(function (global) {
  'use strict';

  const { h, svgEl, key, tag, shortDate, nf, pct } = global.dom;

  const TABS = [
    ['tree', 'TREE'],
    ['relations', 'RELATIONS'],
    ['decisions', 'DECISIONS'],
  ];

  /** One sentence per view, because a label assumes the model and a sentence
   *  teaches it. The house rule: prefer the sentence to the label. */
  const BLURB = {
    tree: 'Every work package in this project, nested under its parent. A branch is '
        + 'collapsed until you open it and carries the figures for everything inside it.',
    relations: 'What has to happen before what. Only work that carries a relation is '
        + 'drawn — unconnected work says nothing here that the tree does not say better.',
    decisions: 'Which decisions wait on which, and which work each one holds up. '
        + 'A decision connected to nothing in this project is counted, not drawn.',
  };

  const RELATION_LABEL = {
    follows: 'FOLLOWS', blocks: 'BLOCKS', requires: 'REQUIRES',
    relates: 'RELATES TO', duplicates: 'DUPLICATES', includes: 'INCLUDES',
  };
  const DECISION_LINK_LABEL = { blocks: 'BLOCKS', informs: 'INFORMS', arose_from: 'AROSE FROM' };

  // Node geometry, in SVG user units. Wide enough for a work package key and a
  // truncated subject at 12px without the two colliding.
  const NODE_W = 178;
  const NODE_H = 46;
  const GAP_X = 232;
  const GAP_Y = 62;
  const PAD = 14;

  global.viewMap = async function viewMap(app) {
    const view = TABS.some(([id]) => id === app.state.params.view) ? app.state.params.view : 'tree';
    const group = app.state.params.group || 'none';

    if (!app.state.project) {
      return h('div.page', h('div.panel', h('div.panel-body', h('div.empty', {
        text: 'the map is drawn for one project — pick one in the rail',
      }))));
    }

    const data = await global.api.get(`/api/map${global.api.qs({
      project: app.state.project, group,
    })}`);

    return h('div.page.map', [
      header(app, data),
      h('div.map-tabs', TABS.map(([id, label]) => h('button.map-tab' + (id === view ? '.on' : ''), {
        onclick: () => app.setParam('view', id === 'tree' ? null : id),
        text: label,
      }))),
      h('p.map-blurb', { text: BLURB[view] }),
      view === 'tree' ? treeView(app, data)
        : view === 'relations' ? relationsView(app, data)
          : decisionsView(app, data),
    ]);
  };

  // ---------------------------------------------------------------- the header

  /**
   * The project pair. Two things next to each other, never one.
   *
   * The excluded count is a sentence rather than a number in the trio, because
   * a blank cell and a 0 look similar in a table and mean opposite things.
   */
  function header(app, data) {
    const r = data.totals.readiness;
    const c = data.totals.completion;
    return h('div.panel.map-head', [
      h('div.panel-head', [
        h('h2', { text: `${data.project.code} — ${data.project.name}` }),
        h('span.muted', { text: `${data.shown} WORK PACKAGES` }),
      ]),
      h('div.panel-body', [
        h('div.map-pair', [
          h('div.map-readiness', [
            h('div.label', { text: 'READINESS' }),
            h('div.meter', [h('i', { style: { width: pct(r.pct), background: 'var(--accent)' } })]),
            h('div.big', { text: `${r.pct}%` }),
            h('div.sub', { text: `BASIS: WEIGHTED OVER ${r.scored} — THIS IS NOT COMPLETION` }),
          ]),
          h('div.map-completion', [
            h('div.label', { text: 'COMPLETION' }),
            h('div.trio', [
              countBlock('DONE', c.done),
              countBlock('IN BUILD OR SPECCING', c.partial),
              countBlock('NOT STARTED', c.notStarted),
            ]),
            h('div.sub', {
              text: r.excluded
                ? `${r.excluded} DEFERRED OR REJECTED — EXCLUDED FROM THE DENOMINATOR, NOT SCORED ZERO`
                : 'NOTHING IS EXCLUDED FROM THE DENOMINATOR',
            }),
          ]),
        ]),
        data.truncated
          ? h('p.warn', { text: `showing ${data.shown} of ${data.total} work packages — the rest are not drawn` })
          : null,
      ]),
    ]);
  }

  const countBlock = (label, n) => h('div.count', [
    h('div.n', { text: String(n) }),
    h('div.l', { text: label }),
  ]);

  /** The same pair, small, for a group row or a branch. */
  function smallPair(p) {
    const r = p.readiness;
    const c = p.completion;
    return h('div.pair-small', [
      h('div.meter.thin', [h('i', { style: { width: pct(r.pct), background: 'var(--accent)' } })]),
      h('span.v', { text: `${r.pct}% WEIGHTED` }),
      h('span.sep', { text: '·' }),
      h('span.v', { text: `${c.done}/${c.partial}/${c.notStarted} DONE/STARTED/NOT` }),
      r.excluded ? h('span.exc', { text: `${r.excluded} EXCLUDED` }) : null,
    ]);
  }

  // ------------------------------------------------------------------ the tree

  function treeView(app, data) {
    const expanded = new Set((app.state.params.expand || '').split(',').filter(Boolean));
    const toggle = (id) => {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id); else next.add(id);
      app.setParam('expand', next.size ? [...next].join(',') : null);
    };

    return h('div', [
      h('div.map-controls', [
        h('span.label', { text: 'GROUP BY' }),
        ...data.groupings.map((g) => h('button.chip' + (g === data.group ? '.on' : ''), {
          // Changing the grouping changes what the expanded ids mean, so the
          // expansion is dropped with it rather than half-applying to a
          // different set of branches.
          onclick: () => { app.state.params.expand = null; app.setParam('group', g === 'none' ? null : g); },
          text: g.toUpperCase(),
        })),
      ]),
      data.tree.cycles.length
        ? h('p.warn', {
          text: `${data.tree.cycles.length} work package(s) sit in a parent cycle and are listed flat at the end`,
        })
        : null,
      ...data.tree.groups.map((g) => groupPanel(app, g, expanded, toggle)),
    ]);
  }

  function groupPanel(app, g, expanded, toggle) {
    const gid = `g:${g.key === null ? '' : g.key}`;
    const open = g.label === null || expanded.has(gid);

    // Only rows whose every ancestor is open. Computed by walking the flat list
    // in order and carrying a "hidden below this depth" mark, which is what the
    // server's depth ordering already makes possible.
    const visible = [];
    let hideBelow = null;
    for (const r of g.rows) {
      if (hideBelow !== null && r.depth > hideBelow) continue;
      hideBelow = null;
      visible.push(r);
      if (r.childCount && !expanded.has(String(r.id))) hideBelow = r.depth;
    }

    return h('div.panel.map-group', [
      g.label === null ? null : h('button.map-group-head', {
        onclick: () => toggle(gid),
        'aria-expanded': open ? 'true' : 'false',
      }, [
        h('span.caret', { text: open ? '▾' : '▸' }),
        h('span.name', { text: g.label }),
        h('span.n', { text: `${g.completion.total}` }),
        smallPair(g),
      ]),
      open ? h('div.panel-body.map-rows', visible.map((r) => treeRow(app, r, expanded, toggle))) : null,
    ]);
  }

  function treeRow(app, r, expanded, toggle) {
    const isOpen = expanded.has(String(r.id));
    return h('div.map-row' + (r.orphaned ? '.orphan' : ''), {
      style: { 'padding-left': `${8 + r.depth * 18}px` },
    }, [
      r.childCount
        ? h('button.caret-btn', {
          onclick: () => toggle(String(r.id)),
          'aria-expanded': isOpen ? 'true' : 'false',
          'aria-label': isOpen ? 'Collapse' : 'Expand',
          text: isOpen ? '▾' : '▸',
        })
        : h('span.caret-spacer', { text: '' }),
      h('button.map-row-main', { onclick: () => app.openWp(r.id) }, [
        key(r.key),
        h('span.subject', { text: r.subject }),
        tag(r.status_label, r.status_colour, true),
        // A NULL progress weight is the whole rule made visible. Saying it in
        // words beats a blank cell, which looks the same as a zero.
        r.progress_weight === null ? h('span.excluded', { text: 'EXCLUDED' }) : null,
        r.story_points === null || r.story_points === undefined
          ? null : h('span.pts', { text: `${nf(r.story_points)} PTS` }),
        r.due_date ? h('span.due', { text: shortDate(r.due_date) }) : null,
      ]),
      r.subtree && !isOpen
        ? h('span.branch-pair', [
          h('span.kids', { text: `${r.childCount} INSIDE` }),
          smallPair(r.subtree),
        ])
        : null,
      r.orphaned ? h('span.excluded', { text: 'IN A PARENT CYCLE' }) : null,
    ]);
  }

  // ------------------------------------------------------------- the relations

  function relationsView(app, data) {
    const rel = data.relations;

    if (!rel.nodeCount) {
      return h('div.panel', h('div.panel-body', h('div.empty', {
        text: 'no work package in this project has a relation, so there is nothing to draw',
      })));
    }
    if (!rel.drawn) {
      return h('div.panel', h('div.panel-body', [
        h('div.empty', {
          text: `${rel.nodeCount} work packages carry a relation, over the ${rel.limit} this screen will draw`,
        }),
        h('p.muted', {
          text: 'A graph this size is a picture nobody can read. Filter the work first on the '
              + 'work packages screen, or open a smaller branch from the tree.',
        }),
        h('button.btn', { onclick: () => app.go('work', { project: app.state.project }), text: 'WORK PACKAGES' }),
      ]));
    }

    const byId = new Map(rel.nodes.map((n) => [n.id, n]));
    const pos = layout(rel.columns);

    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'What comes before what' }),
        h('span.muted', { text: `${rel.nodeCount} CONNECTED · ${rel.edgeCount} RELATIONS` }),
      ]),
      rel.cycles.length
        ? h('div.panel-body', h('p.blocked-note', {
          text: `${rel.cycles.length} relation(s) close a loop: `
              + rel.cycles.map((c) => `${c.to_key} → ${c.from_key}`).join(', ')
              + '. A plan cannot be derived through a loop, so somebody has to decide which link to cut.',
        }))
        : null,
      h('div.graph-svg', [graph(pos, rel.edges.map((e) => ({
        a: e.before === null ? e.from_id : e.before,
        b: e.after === null ? e.to_id : e.after,
        directed: e.after !== null,
        label: RELATION_LABEL[e.kind] || e.kind,
        loop: e.closesLoop,
        dim: e.after === null,
      })), rel.nodes.map((n) => ({
        id: n.id, key: n.key, label: n.subject, colour: n.status_colour,
        excluded: n.progress_weight === null, onclick: () => app.openWp(n.id),
      })))]),
      h('div.graph-list', relationList(app, rel, byId)),
    ]);
  }

  /** The same graph as a nested list, for a narrow screen. Same data, same
   *  colours; the arrow becomes a word. */
  function relationList(app, rel, byId) {
    const outgoing = new Map();
    for (const e of rel.edges) {
      if (!outgoing.has(e.from_id)) outgoing.set(e.from_id, []);
      outgoing.get(e.from_id).push(e);
    }
    return rel.nodes.map((n) => h('div.glist-node', [
      h('button.glist-head', { onclick: () => app.openWp(n.id) }, [
        h('span.dot', { style: { background: n.status_colour } }),
        key(n.key),
        h('span.subject', { text: n.subject }),
        n.progress_weight === null ? h('span.excluded', { text: 'EXCLUDED' }) : null,
      ]),
      h('div.glist-edges', (outgoing.get(n.id) || []).map((e) => h('div.glist-edge' + (e.closesLoop ? '.loop' : ''), [
        h('span.rel', { text: RELATION_LABEL[e.kind] || e.kind }),
        h('span.arrow', { text: '→' }),
        h('span.k', { text: byId.has(e.to_id) ? byId.get(e.to_id).key : String(e.to_id) }),
        e.lag_days ? h('span.lag', { text: `+${e.lag_days}d` }) : null,
        e.closesLoop ? h('span.loopmark', { text: 'CLOSES A LOOP' }) : null,
      ]))),
    ]));
  }

  // ------------------------------------------------------------- the decisions

  function decisionsView(app, data) {
    const dec = data.decisions;

    if (!dec.nodeCount) {
      return h('div.panel', h('div.panel-body', [
        h('div.empty', { text: 'no decision is connected to this project’s work' }),
        dec.unconnected
          ? h('p.muted', { text: `${dec.unconnected} decision(s) exist in scope and are connected to nothing here.` })
          : null,
        h('button.btn', { onclick: () => app.go('decisions', { project: app.state.project }), text: 'DECISIONS' }),
      ]));
    }

    const pos = layout(dec.columns);
    const linksOf = new Map();
    for (const l of dec.links) {
      if (!linksOf.has(l.decision_id)) linksOf.set(l.decision_id, []);
      linksOf.get(l.decision_id).push(l);
    }

    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Which decisions gate which' }),
        h('span.muted', { text: `${dec.nodeCount} DRAWN · ${dec.edges.length} GATES · ${dec.links.length} LINKS TO WORK` }),
      ]),
      dec.unconnected || dec.offMapLinks
        ? h('div.panel-body', h('p.muted', {
          text: [
            dec.unconnected ? `${dec.unconnected} decision(s) in scope are connected to nothing on this map` : null,
            dec.offMapLinks ? `${dec.offMapLinks} link(s) point at work in another project` : null,
          ].filter(Boolean).join('; ') + '. Not drawn here; all of them are on the decisions screen.',
        }))
        : null,

      h('div.graph-svg', [graph(pos, dec.edges.map((e) => ({
        // Stored as "decision_id depends on depends_on_id", so the arrow runs
        // from the one that has to be answered first to the one that waits.
        a: e.to, b: e.from, directed: true, label: 'GATES', loop: false, dim: false,
      })), dec.nodes.map((n) => ({
        id: n.id, key: n.ref, label: n.title, colour: global.decisionColour(n),
        excluded: false,
        badge: n.blocksCount ? `${n.blocksCount} BLOCKED` : null,
        onclick: () => app.go('decisions', { project: app.state.project, decision: n.ref }),
      })))]),

      h('div.graph-list', dec.nodes.map((n) => decisionListItem(app, n, linksOf.get(n.id) || []))),
      h('div.panel-body.map-links', [
        h('div.label', { text: 'WHAT EACH DECISION HOLDS UP' }),
        dec.links.length
          ? h('div', dec.links.map((l) => workLinkRow(app, l)))
          : h('div.empty', { text: 'no decision on this map is linked to work in it' }),
      ]),
    ]);
  }

  function decisionListItem(app, n, links) {
    return h('div.glist-node', [
      h('button.glist-head', {
        onclick: () => app.go('decisions', { project: app.state.project, decision: n.ref }),
      }, [
        h('span.dot', { style: { background: global.decisionColour(n) } }),
        key(n.ref),
        h('span.subject', { text: n.title }),
        h('span.state', { text: n.state.toUpperCase() }),
        n.portfolio ? h('span.pill', { text: 'PORTFOLIO' }) : null,
      ]),
      h('div.glist-edges', links.map((l) => h('div.glist-edge', [
        h('span.rel', { text: DECISION_LINK_LABEL[l.relation] || l.relation }),
        h('span.arrow', { text: '→' }),
        h('span.k', { text: l.wp_key }),
        l.origin === 'person' ? null : h('span.origin', { text: originWords(l) }),
      ]))),
    ]);
  }

  function workLinkRow(app, l) {
    return h('div.map-link-row', [
      key(l.ref),
      h('span.rel', { text: DECISION_LINK_LABEL[l.relation] || l.relation }),
      h('button.map-row-main', { onclick: () => app.openWp(l.work_package_id) }, [
        key(l.wp_key),
        h('span.subject', { text: l.subject }),
        h('span.dot', { style: { background: l.status_colour } }),
      ]),
      // A person's claim and a matcher's claim are not the same claim, and this
      // is the only place on the map that says which this is. The git deck's
      // rule, one layer out.
      l.origin === 'person' ? null : h('span.origin', { text: originWords(l) }),
    ]);
  }

  const originWords = (l) => (l.origin === 'matcher'
    ? `A MATCHER FOUND THIS IN THE ${String(l.matched_in || 'RECORD').toUpperCase()}, NOT A PERSON`
    : 'MADE BY AN IMPORT, NOT A PERSON');

  // --------------------------------------------------------------- the drawing

  /** Column index and row index to a box position. Pure pixel arithmetic. */
  function layout(columns) {
    const pos = new Map();
    columns.forEach((col, ci) => col.forEach((id, ri) => {
      pos.set(id, { x: PAD + ci * GAP_X, y: PAD + ri * GAP_Y });
    }));
    const width = PAD * 2 + Math.max(1, columns.length) * GAP_X - (GAP_X - NODE_W);
    const rows = Math.max(1, ...columns.map((c) => c.length));
    const height = PAD * 2 + rows * GAP_Y - (GAP_Y - NODE_H);
    return { pos, width, height };
  }

  /**
   * The picture. Edges first so a node box always sits on top of a line
   * crossing it, which is the difference between a readable graph and a mess.
   *
   * An edge runs from `a` (the one that comes first, so the shallower rank) to
   * `b`. A cubic curve rather than a straight line: two straight lines between
   * the same pair of columns overlap exactly and read as one.
   */
  function graph({ pos, width, height }, edges, nodes) {
    return svgEl('svg', {
      viewBox: `0 0 ${width} ${height}`, width, height,
      role: 'img', 'aria-label': 'Graph. The same information is listed below.',
    }, [
      svgEl('defs', [
        svgEl('marker', {
          id: 'map-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
          markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
        }, [svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'var(--ink-5)' })]),
        svgEl('marker', {
          id: 'map-arrow-loop', viewBox: '0 0 8 8', refX: 7, refY: 4,
          markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
        }, [svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: 'var(--blocked)' })]),
      ]),

      svgEl('g.edges', edges.map((e) => {
        const a = pos.get(e.a);
        const b = pos.get(e.b);
        if (!a || !b) return null;
        const x1 = a.x + NODE_W;
        const y1 = a.y + NODE_H / 2;
        const x2 = b.x;
        const y2 = b.y + NODE_H / 2;
        const bend = Math.max(24, Math.abs(x2 - x1) / 2);
        return svgEl('path.edge' + (e.loop ? '.loop' : '') + (e.dim ? '.dim' : ''), {
          d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
          fill: 'none',
          stroke: e.loop ? 'var(--blocked)' : 'var(--line-3)',
          'stroke-width': e.loop ? 2 : 1.25,
          'stroke-dasharray': e.dim ? '3 3' : null,
          'marker-end': e.directed ? `url(#${e.loop ? 'map-arrow-loop' : 'map-arrow'})` : null,
        }, [svgEl('title', { text: e.label })]);
      })),

      svgEl('g.nodes', nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        return svgEl('g.node', {
          transform: `translate(${p.x} ${p.y})`,
          role: 'button', tabindex: '0',
          onclick: n.onclick,
          onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); n.onclick(); } },
        }, [
          svgEl('title', { text: `${n.key} — ${n.label}` }),
          svgEl('rect.node-box', {
            width: NODE_W, height: NODE_H, rx: 6,
            fill: 'var(--panel-2)', stroke: 'var(--line)',
          }),
          // The status colour as a stripe rather than a fill: a filled box in a
          // status colour competes with the reserved-colour rule at a glance,
          // and a stripe reads the same at a tenth of the area.
          svgEl('rect.node-stripe', { width: 3, height: NODE_H, rx: 1.5, fill: n.colour || 'var(--ink-5)' }),
          svgEl('text.node-key', { x: 12, y: 18, text: n.key }),
          svgEl('text.node-label', { x: 12, y: 34, text: clip(n.label, 24) }),
          n.excluded ? svgEl('text.node-exc', { x: NODE_W - 10, y: 18, 'text-anchor': 'end', text: 'EXCL' }) : null,
          n.badge ? svgEl('text.node-badge', { x: NODE_W - 10, y: 34, 'text-anchor': 'end', text: n.badge }) : null,
        ]);
      })),
    ]);
  }

  /** Truncate for a fixed-width box. The full text is in the <title> and in the
   *  list below, so nothing is only available in the truncated form. */
  const clip = (text, n) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));
}(window));
