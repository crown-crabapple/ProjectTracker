/*
 * Projects & programs.
 *
 * The portfolio table, grouped by program, with the life cycle drawn as a strip
 * per project. The percentage in the Progress column is WEIGHTED READINESS, not
 * completion — the panel note under the table says so, because a bare percentage
 * in a portfolio table is the single most misread number in a tool like this.
 */

(function (global) {
  'use strict';

  const { h, kpi, tag, key, nf, pct } = global.dom;

  global.viewPortfolio = async function viewPortfolio(app) {
    const favouritesOnly = app.state.params.favourites === '1';
    const data = await global.api.get(`/api/portfolio${global.api.qs({ favourites: favouritesOnly ? 1 : null })}`);
    const k = data.kpis;

    return h('div.page', [
      h('div.page-head', [
        h('div.page-title', { text: 'Projects & programs' }),
        h('div.spacer'),
        h('button.btn', {
          'aria-pressed': favouritesOnly ? 'true' : 'false',
          onclick: () => app.setParam('favourites', favouritesOnly ? null : '1'),
          text: '★ FAVOURITES ONLY',
        }),
        h('button.btn', {
          onclick: () => shareList(app, data),
          text: 'SHARE THIS LIST',
        }),
        h('button.btn.primary', { onclick: () => newProject(app, data), text: 'NEW PROJECT' }),
      ]),

      h('div.kpis', { style: { 'margin-bottom': '14px' } }, [
        kpi('Projects', String(k.projects), k.projectsSub),
        kpi('Portfolio readiness', `${k.readiness.pct}%`,
          `weighted over ${k.readiness.scored} scored · ${k.readiness.excluded} excluded`),
        kpi('Open work packages', String(k.open), k.openSub, 'plain'),
        kpi('Gates awaiting a decision', String(k.gatesBlocked), k.gatesBlockedSub,
          k.gatesBlocked ? 'blocked' : 'plain'),
      ]),

      ...data.programs.map((program) => programPanel(app, program)),

      h('div.grid.c2', [templatesPanel(app, data), lifecyclePanel(data)]),

      h('p.note', {
        text: 'The Progress column is weighted readiness — speccing 0.35, in build 0.7, done 1 — '
          + 'and is not a completion figure. Deferred and rejected work leaves the denominator '
          + 'entirely, so nothing here can be improved by pushing work out of a project.',
      }),
    ]);
  };

  function programPanel(app, program) {
    return h('div.panel', { style: { 'margin-bottom': '14px' } }, [
      h('div.panel-head', [
        program.code ? key(program.code) : null,
        h('div', { style: { font: '600 12.5px var(--font-prose)' }, text: program.name }),
        h('div.spacer'),
        h('span.panel-note', { text: (program.summary || '').toUpperCase() }),
      ]),
      h('div.scroll-x', [h('table.responsive-table', [
        h('thead', [h('tr', [
          h('th', { style: { width: '44px' }, 'aria-label': 'Favourite' }),
          h('th', { text: 'Project' }),
          h('th', { style: { width: '300px' }, text: 'Life cycle' }),
          h('th', { style: { width: '190px' }, text: 'Readiness' }),
          h('th.r', { style: { width: '70px' }, text: 'Open' }),
          h('th', { style: { width: '130px' }, text: 'Next gate' }),
        ])]),
        h('tbody', program.projects.map((p) => projectRow(app, p))),
      ])]),
    ]);
  }

  function projectRow(app, p) {
    const bar = p.health === 'rust' ? 'var(--blocked)' : p.health === 'green' ? 'var(--ok)' : 'var(--accent)';
    return h('tr.clickable', {
      onclick: () => app.go('overview', { project: p.id }),
    }, [
      h('td', { 'data-label': '' }, [
        h('button', {
          style: {
            background: 'none', border: 'none', cursor: 'pointer', 'font-size': '13px',
            color: p.favourite ? 'var(--accent)' : 'var(--line-3)', padding: '0',
          },
          'aria-label': p.favourite ? `Unfavourite ${p.code}` : `Favourite ${p.code}`,
          onclick: (e) => {
            e.stopPropagation();
            app.act(() => global.api.post(`/api/projects/${p.id}/favourite`, { on: !p.favourite }));
          },
          text: '★',
        }),
      ]),
      h('td', { 'data-label': 'Project' }, [
        h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
          key(p.code), h('span', { text: p.name }),
        ]),
      ]),
      h('td', { 'data-label': 'Life cycle' }, [phaseStrip(p)]),
      h('td', { 'data-label': 'Readiness' }, [
        h('div.meter-row', [
          h('div.meter', [h('i', { style: { width: pct(p.readiness.pct), background: bar } })]),
          h('span.value', { text: `${p.readiness.pct}%` }),
        ]),
      ]),
      h('td.r', { 'data-label': 'Open' }, [
        h('span.tag', { style: { color: 'var(--ink-3)' }, text: String(p.open) }),
      ]),
      h('td', { 'data-label': 'Next gate' }, [
        p.next_gate
          ? tag(
            p.next_gate.gate ? `${p.next_gate.gate} ${p.next_gate.phase.toUpperCase()}` : 'SHIPPED',
            p.next_gate.blocked ? 'var(--blocked)' : 'var(--ink-5)', true
          )
          : tag('NO LIFE CYCLE', 'var(--ink-6)', true),
      ]),
    ]);
  }

  /** The phase strip: one segment per phase, done / current / not entered. */
  function phaseStrip(p) {
    return h('div.phase-line', p.phases.map((ph) => {
      const cls = ph.state === 'blocked' ? 'blocked' : ph.done ? 'done' : ph.current ? 'current' : '';
      return h('div.phase' + (cls ? '.' + cls : ''), { title: `${ph.gate} · ${ph.name}` }, [
        h('div.bar'),
        h('div.name', { text: ph.name.toUpperCase() }),
      ]);
    }));
  }

  function templatesPanel(app, data) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Project templates' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'COPIES PHASES, VERSIONS, ROLES, WIKI SKELETON' }),
      ]),
      h('div.panel-body.tight', [
        h('div.rows', data.templates.map((t) => h('div.row', [
          key(t.code),
          h('div.grow', [
            h('div', { style: { 'font-size': '12.5px' }, text: t.name }),
            h('div', { style: { 'font-size': '11px', color: 'var(--ink-4)' }, text: t.detail || '' }),
          ]),
          h('button.btn.small', {
            onclick: () => newProject(app, data, t),
            text: 'USE',
          }),
        ]))),
      ]),
    ]);
  }

  /**
   * Which phase each project is sitting in, portfolio-wide.
   *
   * Grouped by phase NAME rather than by position, because phase lists differ
   * per template — a manuscript's third phase is not a spec project's third
   * phase, and lining them up by index would invent a comparison.
   */
  function lifecyclePanel(data) {
    return h('div.panel', [
      h('div.panel-head', [h('h2', { text: 'Life cycle · where the projects are' })]),
      h('div.panel-body', [
        data.lifecycle.length
          ? h('div.rows', data.lifecycle.map((l) => h('div.row', [
            h('span', {
              style: {
                width: '2px', height: '12px', 'border-radius': '1px', 'flex-shrink': '0',
                background: l.blocked ? 'var(--blocked)' : 'var(--accent)',
              },
            }),
            h('span.tag', {
              style: { color: l.blocked ? 'var(--blocked)' : 'var(--accent)', 'min-width': '90px' },
              text: l.phase.toUpperCase(),
            }),
            h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-3)' }, text: l.gate }),
            h('span.tag.small', {
              text: `${l.count} PROJECT${l.count === 1 ? '' : 'S'}${l.blocked ? ` · ${l.blocked} BLOCKED` : ''}`,
            }),
          ])))
          : h('div.empty', { text: 'no project has a current phase' }),
        h('p.note', {
          text: 'A project cannot leave a phase until its gate criterion is recorded as met — a date '
            + 'and a person, not a flag. Rust marks a gate whose criterion is itself an open decision, '
            + 'and is the only thing on this page allowed to use that colour.',
        }),
      ]),
    ]);
  }

  // ------------------------------------------------------------------- actions

  async function newProject(app, data, template) {
    const chosen = template || data.templates[0];
    const name = prompt(`New project name${chosen ? ` (from the ${chosen.code} template)` : ''}:`);
    if (!name) return;
    const code = prompt('Short code (2–16 letters or digits):', name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase());
    if (!code) return;
    const created = await app.act(
      () => global.api.post('/api/projects', { name, code, template_id: chosen ? chosen.id : null }),
      `${code} created`
    );
    if (created) app.go('overview', { project: created.id });
  }

  /**
   * Sharing a list mints a real token against a stored list, so the recipient
   * needs no account.
   *
   * The list stores its FILTER, never the resulting set of ids: a list that froze
   * its members would go stale silently, and a stale shared link is worse than no
   * link. The recipient sees what the filter selects for the list's OWNER now,
   * which is the honest reading of "lending your view" — and the expiry and the
   * revoke are how the owner takes it back.
   */
  function shareList(app, data) {
    const shareable = data.lists.filter((l) => l.visibility !== 'private');
    if (!shareable.length) {
      return app.toast(
        'No shareable list. A list is created with a filter and a visibility of "shared"; '
        + 'the seeded "Platform · active" list is the worked example.',
        'bad'
      );
    }
    const chosen = shareable.length === 1
      ? shareable[0]
      : shareable.find((l) => l.name === prompt(
        `Which list?\n\n${shareable.map((l) => l.name).join('\n')}`, shareable[0].name
      ));
    if (!chosen) return null;
    const url = `${location.origin}/share/list/${chosen.share_token || ''}`;
    if (!chosen.share_token) {
      return app.toast(`"${chosen.name}" has no live share link. Create one from the API or the CLI.`, 'bad');
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(
        () => app.toast(`Link to "${chosen.name}" copied. It needs no account and expires on its own date.`, 'good'),
        () => app.toast(url)
      );
    } else {
      app.toast(url);
    }
    return null;
  }
}(window));
