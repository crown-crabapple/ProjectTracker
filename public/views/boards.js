/*
 * Boards.
 *
 * Four kinds, and the columns of all four are DERIVED rather than stored: add a
 * status in administration and a column appears here without a migration.
 *
 * Dragging a card writes the thing the column means — status on a status board,
 * version on a version board, sprint on a sprint board — and goes through the
 * same validation as the drawer. In particular a status board is not a way round
 * the workflow: an illegal transition is refused here exactly as it is there.
 */

(function (global) {
  'use strict';

  const { h, key, nf } = global.dom;

  const MODE_LABELS = {
    status: 'STATUS', version: 'VERSION', subproject: 'SUBPROJECT',
    wbs: 'WORK BREAKDOWN', sprint: 'SPRINT',
  };

  global.viewBoards = async function viewBoards(app) {
    const type = app.state.params.type || 'status';
    const data = await global.api.get(`/api/boards${global.api.qs({ project: app.state.project, type })}`);

    return h('div.page.wide', [
      h('div.page-head', [
        h('div.page-title', { text: 'Boards' }),
        h('div.spacer'),
        h('div.pill-row', data.modes.map((m) => h('button.pill' + (m === type ? '.is-on' : ''), {
          onclick: () => app.setParam('type', m),
          text: MODE_LABELS[m] || m.toUpperCase(),
        }))),
      ]),

      data.columns.length
        ? h('div.board', data.columns.map((c) => column(app, c, type)))
        : h('div.panel', h('div.empty', { text: 'this board has no columns yet' })),

      h('p.note', { text: data.note }),
    ]);
  };

  function column(app, col, boardType) {
    const cards = h('div.board-cards', [
      ...col.cards.map((k) => card(app, k)),
      h('button.card-add', {
        onclick: () => addCard(app, col, boardType),
        text: '+ CARD',
      }),
    ]);

    // Drag and drop, with the drop target highlighted. A board that cannot be
    // dragged is a board people edit through the drawer instead, which is the
    // slow path this view exists to replace.
    cards.addEventListener('dragover', (e) => {
      if (!global.__dragWp) return;
      e.preventDefault();
      cards.classList.add('drop-target');
    });
    cards.addEventListener('dragleave', () => cards.classList.remove('drop-target'));
    cards.addEventListener('drop', (e) => {
      e.preventDefault();
      cards.classList.remove('drop-target');
      const id = global.__dragWp;
      global.__dragWp = null;
      if (!id) return;
      if (col.cards.some((k) => Number(k.id) === Number(id))) return;
      app.act(
        () => global.api.post('/api/boards/move', {
          work_package_id: id, board_type: boardType, column: col.key,
        }),
        `Moved to ${col.title}`
      );
    });

    return h('div.board-col.panel', [
      h('div.board-col-head', [
        h('span.swatch', { style: { background: col.colour } }),
        h('div.title', { style: { color: col.colour }, title: col.title, text: col.title }),
        h('div.meta', { text: col.points ? `${col.meta} · ${col.points} PTS` : col.meta }),
      ]),
      cards,
    ]);
  }

  function card(app, k) {
    const el = h('div.card', {
      draggable: 'true',
      tabindex: '0',
      role: 'button',
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
        h('span.who', { text: k.assignee || 'unassigned' }),
        h('div.spacer'),
        k.story_points ? points(k) : null,
        k.overdue ? h('span.tag.small', { style: { color: 'var(--blocked)' }, text: 'LATE' }) : null,
      ]),
    ]);
    el.addEventListener('dragstart', () => { global.__dragWp = k.id; el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); global.__dragWp = null; });
    return el;
  }

  /**
   * A card's points.
   *
   * A container's own estimate is shown dimmed, with the reason in the tooltip:
   * it is NOT in the column total, because a parent never double-counts its
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
          + 'column total, which sums leaf work only'
        : `${k.story_points} points`,
      text: nf(k.story_points),
    });
  }

  async function addCard(app, col, boardType) {
    const subject = prompt(`New work package in "${col.title}":`);
    if (!subject) return;
    const created = await app.act(
      () => global.api.post('/api/wp', { project_id: app.state.project, subject, type: 'TASK' }),
      'Created'
    );
    if (!created) return;
    // Two steps rather than one: creation does not know what a board column
    // means, and teaching it would put board semantics in the work package
    // endpoint.
    await app.act(() => global.api.post('/api/boards/move', {
      work_package_id: created.wp.id, board_type: boardType, column: col.key,
    }));
  }
}(window));
