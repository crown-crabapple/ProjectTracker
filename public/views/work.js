/*
 * The work package list.
 *
 * The left edge of each row carries the highlight colour, and what that colour
 * means is the viewer's preference (status, priority, overdue, or none) rather
 * than a fixed choice. Changing it writes the preference, so the same reading
 * comes back tomorrow.
 *
 * Indentation is the parent-child hierarchy. A row whose parent is not in the
 * filtered set is drawn at depth zero rather than hidden, because a row that
 * disappears from a filtered list is worse than one out of place.
 */

(function (global) {
  'use strict';

  const { h, tag, key, nf } = global.dom;

  const HIGHLIGHTS = ['status', 'priority', 'overdue', 'none'];

  global.viewWork = async function viewWork(app) {
    const params = {
      project: app.state.project,
      q: app.state.q || null,
      status: app.state.params.status || null,
      type: app.state.params.type || null,
      priority: app.state.params.priority || null,
      version: app.state.params.version || null,
      sprint: app.state.params.sprint || null,
      overdue: app.state.params.overdue || null,
      unassigned: app.state.params.unassigned || null,
      open: app.state.params.open || null,
      sort: app.state.params.sort || null,
    };
    const data = await global.api.get(`/api/work${global.api.qs(params)}`, { key: 'work' });
    const filtered = ['status', 'type', 'priority', 'version', 'sprint', 'overdue', 'unassigned', 'open']
      .some((k) => app.state.params[k]) || Boolean(app.state.q);

    return h('div.page.wide', [
      h('div.page-head', [
        h('div.page-title', { text: 'Work packages' }),
        h('div.page-sub', {
          text: `${data.shown} of ${data.total} shown · highlighting by ${data.highlightMode}`,
        }),
        h('div.spacer'),
        h('div.pill-row', HIGHLIGHTS.map((mode) => h('button.pill' + (data.highlightMode === mode ? '.is-on' : ''), {
          onclick: () => app.act(
            () => global.api.patch('/api/preferences', { highlight_mode: mode })
          ),
          title: `Highlight the left edge by ${mode}`,
          text: mode.toUpperCase(),
        }))),
        filtered
          ? h('button.btn', { onclick: () => clearFilters(app), text: 'CLEAR' })
          : null,
        exportMenu(app),
        h('button.btn.primary', { onclick: () => newWorkPackage(app), text: 'NEW WORK PACKAGE' }),
      ]),

      h('div.panel', { style: { padding: '13px 16px', 'margin-bottom': '14px' } }, [
        h('div', { style: { display: 'flex', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' } }, [
          h('div.label', { text: 'Status' }),
          h('div.pill-row', data.statusFilters.map((s) => h('button.pill' + (app.state.params.status === s.code ? '.is-on' : ''), {
            onclick: () => app.setParam('status', app.state.params.status === s.code ? null : s.code),
            text: `${s.label} ${s.count}`,
          }))),
          h('div.spacer'),
          h('div.label', { text: 'Type' }),
          h('div.pill-row', data.typeFilters.map((t) => h('button.pill' + (app.state.params.type === t.name ? '.is-on' : ''), {
            onclick: () => app.setParam('type', app.state.params.type === t.name ? null : t.name),
            text: `${t.name} ${t.count}`,
          }))),
        ]),
      ]),

      h('div.panel.raised', [
        data.rows.length
          ? h('div.scroll-x', [table(app, data)])
          : h('div.empty', { text: 'nothing matches those filters' }),
      ]),

      data.cycles.length
        ? h('p.note', {
          style: { color: 'var(--blocked)' },
          text: `${data.cycles.length} work package(s) are in a loop in the parent chain and are shown flat: `
            + `${data.cycles.join(', ')}. Nothing in the app can create one — this is a hand-edited row.`,
        })
        : null,

      h('p.note', {
        text: 'The left edge carries the highlight colour. Indentation is the parent-child hierarchy; '
          + 'a child cannot leave the dates of an automatically scheduled parent, but it can against a '
          + 'manual one — which is the only way to plan a slip without rewriting the parent.',
      }),
    ]);
  };

  const COLUMNS = [
    { key: 'id', label: 'ID', sort: 'id' },
    { key: 'subject', label: 'Subject', sort: 'subject' },
    { key: 'status', label: 'Status', sort: 'status' },
    { key: 'assignee', label: 'Assignee' },
    { key: 'accountable', label: 'Accountable' },
    { key: 'watchers', label: 'Watch', right: true },
    { key: 'priority', label: 'Priority', sort: 'priority' },
    { key: 'dates', label: 'Dates', sort: 'due' },
    { key: 'points', label: 'Pts', right: true, sort: 'points' },
    { key: 'version', label: 'Version' },
    { key: 'sprint', label: 'Sprint' },
  ];

  function table(app, data) {
    const currentSort = app.state.params.sort || 'id';
    return h('table.responsive-table', [
      h('thead', [h('tr', COLUMNS.map((c) => h(c.right ? 'th.r' : 'th', {
        style: c.sort ? { cursor: 'pointer' } : null,
        onclick: c.sort ? () => toggleSort(app, c.sort, currentSort) : null,
        title: c.sort ? `Sort by ${c.label.toLowerCase()}` : null,
        text: c.label + (currentSort === c.sort ? ' ↑' : currentSort === '-' + c.sort ? ' ↓' : ''),
      })))]),
      h('tbody', data.rows.map((w) => row(app, w))),
    ]);
  }

  function row(app, w) {
    return h('tr.clickable', {
      onclick: () => app.openWp(w.id),
      style: { 'border-left': `2px solid ${w.highlight || 'transparent'}` },
    }, [
      h('td', { 'data-label': 'ID' }, [key(w.key)]),
      h('td', {
        'data-label': 'Subject',
        style: { 'padding-left': `${14 + w.depth * 18}px` },
      }, [
        h('span.type-tag', { style: { color: w.type_colour }, text: w.type }),
        w.subject,
        w.orphaned ? h('span.tag.small', { style: { color: 'var(--blocked)' }, text: ' ↯ LOOP' }) : null,
      ]),
      h('td', { 'data-label': 'Status' }, [tag(w.status_label, w.status_colour)]),
      h('td', { 'data-label': 'Assignee' }, [
        h('span', {
          style: { 'font-size': '11.5px', color: w.assignee_kind === 'placeholder' ? 'var(--ink-6)' : 'var(--ink-3)' },
          text: w.assignee || '—',
        }),
      ]),
      h('td.dim', { 'data-label': 'Accountable', style: { 'font-size': '11.5px' }, text: w.accountable || '—' }),
      h('td.r', { 'data-label': 'Watch' }, [
        h('span.tag', { style: { color: 'var(--ink-5)' }, text: w.watchers ? String(w.watchers) : '—' }),
      ]),
      h('td', { 'data-label': 'Priority' }, [tag(w.priority_label, w.priority_colour, true)]),
      h('td', { 'data-label': 'Dates' }, [
        h('span.tag', {
          style: { color: w.overdue ? 'var(--blocked)' : 'var(--ink-4)', 'white-space': 'nowrap' },
          text: w.dates,
        }),
      ]),
      h('td.r', { 'data-label': 'Pts' }, [
        h('span.tag', { style: { color: 'var(--ink-3)' }, text: nf(w.story_points) }),
      ]),
      h('td', { 'data-label': 'Version' }, [tag(w.version || '—', 'var(--ink-4)', true)]),
      h('td', { 'data-label': 'Sprint' }, [
        tag(w.sprint || '—', w.sprint_shared ? 'var(--sel)' : 'var(--ink-4)', true),
      ]),
    ]);
  }

  function toggleSort(app, column, current) {
    app.setParam('sort', current === column ? `-${column}` : column);
  }

  function clearFilters(app) {
    app.state.q = '';
    for (const k of ['status', 'type', 'priority', 'version', 'sprint', 'overdue', 'unassigned', 'open', 'q']) {
      delete app.state.params[k];
    }
    if (!app.writeHash()) app.render();
  }

  /**
   * Export. The link is a plain href so the browser's own download handling
   * applies — a fetch would put the bytes in memory and then need a blob URL to
   * hand them back, for no gain.
   */
  function exportMenu(app) {
    const query = global.api.qs({
      project: app.state.project,
      q: app.state.q || null,
      status: app.state.params.status || null,
      type: app.state.params.type || null,
      sort: app.state.params.sort || null,
    });
    return h('div.pill-row', ['csv', 'xlsx', 'pdf'].map((f) => h('a.pill', {
      href: `/api/export/work/${f}${query}`,
      download: '',
      text: f.toUpperCase(),
      title: `Export what is on screen as ${f.toUpperCase()}`,
    })));
  }

  async function newWorkPackage(app) {
    const subject = prompt('Subject (leave blank on a BUG to let the type generate one):');
    if (subject === null) return;
    const types = app.boot.types.map((t) => t.name).join(' · ');
    const typeName = prompt(`Type — ${types}:`, 'TASK');
    if (!typeName) return;
    const type = app.boot.types.find((t) => t.name.toUpperCase() === typeName.trim().toUpperCase());
    if (!type) return app.toast(`no type called "${typeName}"`, 'bad');
    const created = await app.act(
      () => global.api.post('/api/wp', {
        project_id: app.state.project, type_id: type.id, subject,
      }),
      'Created'
    );
    if (created) {
      if (created.generatedSubject) app.toast(`Subject generated: ${created.wp.subject}`, 'good');
      app.openWp(created.wp.id);
    }
    return null;
  }
}(window));
