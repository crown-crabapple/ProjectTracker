/*
 * Backlogs & sprints.
 *
 * Several sprints can be active at once, and a sprint can be shared across
 * projects — the SAFe case. A shared sprint's column shows every card in it,
 * from every project that draws on it, because planning a shared sprint means
 * seeing all of it. Its points count in each project and once in velocity.
 */

(function (global) {
  'use strict';

  const { h, key, nf, pct } = global.dom;

  global.viewBacklogs = async function viewBacklogs(app) {
    const data = await global.api.get(`/api/backlogs${global.api.qs({ project: app.state.project })}`);

    return h('div.page.wide', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Backlogs & sprints' }),
        h('div.page-sub', {
          text: data.activeCount > 1
            ? `${data.activeCount} sprints are active at once`
              + (data.columns.some((c) => c.sharing === 'system')
                ? ' — one of them is shared across projects' : '')
            : data.activeCount === 1 ? 'one active sprint' : 'no active sprint',
        }),
      ]),

      h('div.grid.c2-wide', { style: { 'grid-template-columns': 'minmax(0,1fr) 260px', 'margin-top': '0' } }, [
        h('div.board', [
          ...data.columns.map((c) => sprintColumn(app, c)),
          backlogColumn(app, data),
        ]),
        velocityPanel(data),
      ]),
    ]);
  };

  function sprintColumn(app, c) {
    const shared = c.sharing === 'system';
    return h('div.board-col.narrow.panel', [
      h('div', { style: { padding: '11px 13px', 'border-bottom': '1px solid var(--line)' } }, [
        h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
          h('span', {
            style: {
              font: '600 12px var(--font-label)',
              color: c.state === 'active' ? 'var(--accent)' : 'var(--ink-5)',
            },
            text: c.code,
          }),
          h('span.tag.small', {
            style: { color: c.state === 'active' ? 'var(--accent)' : 'var(--ink-5)' },
            text: c.state.toUpperCase(),
          }),
          h('div.spacer'),
          h('span.tag.small', { text: `${c.points} PTS` }),
        ]),
        h('div', {
          style: { font: '400 9.5px var(--font-label)', 'letter-spacing': '.08em', color: 'var(--ink-5)', 'margin-top': '4px' },
          text: c.dates,
        }),
        h('div.tag.small', {
          style: { color: shared ? 'var(--sel)' : 'var(--ink-5)', 'margin-top': '3px' },
          text: shared ? (c.scope_detail || 'SHARED').toUpperCase() : 'THIS PROJECT',
        }),
        h('div.meter-row', { style: { 'margin-top': '8px' } }, [
          h('div.meter.thin', [h('i', { style: { width: pct(c.pct), background: 'var(--ok)' } })]),
          h('span.value', { style: { 'min-width': '0' }, text: c.burn }),
        ]),
        c.state === 'active'
          ? h('button.btn.small', {
            style: { 'margin-top': '8px' },
            onclick: () => closeSprint(app, c),
            text: 'CLOSE SPRINT',
          })
          : null,
      ]),
      h('div.board-cards', c.cards.length
        ? c.cards.map((k) => sprintCard(app, k, shared))
        : [h('div.empty', { style: { padding: '14px 0' }, text: 'empty' })]),
    ]);
  }

  function sprintCard(app, k, shared) {
    return h('div.card', {
      role: 'button', tabindex: '0',
      style: { 'border-left-color': k.status_colour },
      onclick: () => app.openWp(k.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.openWp(k.id); } },
    }, [
      h('div.card-top', [
        h('span.id', { text: k.key }),
        h('span.type-tag', { style: { color: k.type_colour, margin: '0' }, text: k.type }),
        h('div.spacer'),
        h('span.prio', { style: { background: k.priority_colour }, title: k.priority_label }),
      ]),
      h('div.subject', { text: k.subject }),
      h('div.card-foot', [
        // On a shared sprint the project code is the fact that matters: the same
        // column holds cards from three projects.
        shared ? h('span.key', { text: k.project_code }) : h('span.who', { text: k.assignee || 'unassigned' }),
        h('div.spacer'),
        k.story_points ? points(k) : null,
      ]),
    ]);
  }

  /**
   * A card's points.
   *
   * A container's own estimate is shown dimmed, with the reason in the tooltip:
   * it is NOT in the sprint total, because a parent never double-counts its
   * children. Hiding it would be tidier and would leave a reader wondering why an
   * epic has no estimate at all.
   */
  const CONTAINERS = new Set(['PHASE', 'EPIC']);
  function points(k) {
    const container = CONTAINERS.has(k.type);
    return h('span.pts', {
      style: container ? { color: 'var(--ink-6)' } : null,
      title: container
        ? `${k.story_points} points on the ${k.type.toLowerCase()} itself — not counted in the `
          + 'sprint total, which sums leaf work only'
        : `${k.story_points} points`,
      text: nf(k.story_points),
    });
  }

  function backlogColumn(app, data) {
    return h('div.board-col.narrow.panel', [
      h('div', { style: { padding: '11px 13px', 'border-bottom': '1px solid var(--line)' } }, [
        h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
          h('span', { style: { font: '600 12px var(--font-label)', color: 'var(--ink-3)' }, text: 'PRODUCT BACKLOG' }),
          h('div.spacer'),
          h('span.tag.small', { text: `${data.backlog.points} PTS` }),
        ]),
        h('div', {
          style: { font: '400 9.5px var(--font-label)', 'letter-spacing': '.08em', color: 'var(--ink-5)', 'margin-top': '4px' },
          text: `${data.backlog.count} ITEMS · UNSCHEDULED`,
        }),
      ]),
      h('div.board-cards', data.backlog.cards.length
        ? data.backlog.cards.map((k) => sprintCard(app, k, false))
        : [h('div.empty', { style: { padding: '14px 0' }, text: 'nothing unscheduled' })]),
    ]);
  }

  /**
   * Velocity: closed leaf points per sprint.
   *
   * A recorded figure and a computed one are drawn differently, because they are
   * different claims: a computed bar can be traced to its cards, a recorded one
   * cannot. An active sprint with nothing closed reads zero, which is correct and
   * not a gap in the data.
   */
  function velocityPanel(data) {
    const max = Math.max(10, ...data.velocity.map((v) => v.points));
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Velocity' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'CLOSED POINTS' }),
      ]),
      h('div.panel-body', [
        h('div.bars', {
          style: { 'grid-template-columns': `repeat(${Math.max(1, data.velocity.length)}, 1fr)` },
        }, data.velocity.map((v) => h('div.col', [
          h('div.well', { style: { height: '70px' } }, [
            h('i', {
              style: {
                height: pct((v.points / max) * 100),
                background: v.source === 'recorded' ? 'rgba(232,169,75,.4)' : 'var(--accent)',
              },
              title: v.source === 'recorded'
                ? 'recorded before the work was itemised'
                : 'computed from the cards',
            }),
          ]),
          h('div.cap', { text: v.code }),
          h('div.val', { text: String(v.points) }),
        ]))),
        h('p.note', {
          text: 'Closed points per sprint, over leaf work only — epics and phases are excluded so a '
            + 'parent never double-counts its children. A shared sprint counts its points in every '
            + 'project that draws from it, and once here. Solid bars are computed from the cards; '
            + 'faded ones were recorded before the work was itemised.',
        }),
      ]),
    ]);
  }

  function closeSprint(app, c) {
    const open = c.cards.filter((k) => !k.is_closed).length;
    const ok = confirm(
      `Close ${c.code}?\n\n${open} work package(s) in it are still open. `
      + 'The "carry the unfinished forward" automation, if it is on for this project, will move them '
      + 'into the next sprint and record that it did.'
    );
    if (!ok) return;
    app.act(() => global.api.post(`/api/sprints/${c.id}/close`), `${c.code} closed`);
  }
}(window));
