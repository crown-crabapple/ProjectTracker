/*
 * The project overview: a widget dashboard.
 *
 * The widget list comes from the database (dashboard_widgets), so the layout is
 * data rather than code and rearranging it does not need a deploy. A widget kind
 * this file does not know how to draw is skipped with a note rather than
 * crashing the page — a dashboard is the one screen that must survive a
 * half-finished configuration.
 */

(function (global) {
  'use strict';

  const { h, kpi, tag, key, nf, pct, avatar } = global.dom;

  global.viewOverview = async function viewOverview(app) {
    const project = app.state.project;
    if (!project) return h('div.page', h('div.empty', { text: 'pick a project' }));
    const data = await global.api.get(`/api/projects/${project}/overview`);

    const widgets = data.widgets.length
      ? data.widgets
      : ['lifecycle', 'kpi_strip', 'status_breakdown', 'versions', 'members', 'activity'].map((kind) => ({ kind }));

    const drawn = new Map();
    for (const w of widgets) {
      if (WIDGETS[w.kind]) drawn.set(w.kind, WIDGETS[w.kind](app, data, w));
    }
    const unknown = widgets.filter((w) => !WIDGETS[w.kind]).map((w) => w.kind);

    return h('div.page', [
      h('div.page-head.baseline', [
        key(data.project.code),
        h('div.page-title', { text: data.project.name }),
        h('div.page-sub', {
          text: data.lifecycle.current
            ? `phase ${data.lifecycle.current.name.toLowerCase()} · gate ${data.lifecycle.current.gate_name}`
            : data.lifecycle.shipped ? 'every gate met' : 'no life cycle recorded',
        }),
        h('div.spacer'),
        data.project.program
          ? h('span.panel-note', { text: `${data.project.program.code} · ${data.project.program.name}` })
          : null,
        h('button.btn', { onclick: () => setHealth(app, data), text: 'SET HEALTH' }),
        h('button.btn', { onclick: () => takeBaseline(app, data), text: 'SET BASELINE' }),
      ]),

      drawn.get('lifecycle') || null,
      drawn.get('kpi_strip') || null,

      h('div.grid.c2', [
        drawn.get('status_breakdown') || null,
        h('div.stack', [
          drawn.get('versions') || null,
          drawn.get('members') || null,
          drawn.get('activity') || null,
        ]),
      ]),

      unknown.length
        ? h('p.note', { text: `This dashboard also configures ${unknown.join(', ')}, which this build does not draw yet.` })
        : null,
    ]);
  };

  const WIDGETS = {
    /**
     * The life cycle. Each phase shows its gate criterion in full, because a
     * gate whose criterion is not on screen is a gate nobody can check.
     */
    lifecycle: (app, data) => h('div.panel', { style: { 'margin-bottom': '14px' } }, [
      h('div.panel-head', [
        h('h2', { text: 'Life cycle · phases and gates' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'A GATE MUST BE RECORDED BEFORE THE NEXT PHASE OPENS' }),
      ]),
      h('div.panel-body', [
        // A project with no phases is a real state — one created without a
        // template, or imported from a tracker that had none — and an empty
        // panel under a heading about gates reads as something that failed to
        // load. Say which it is.
        data.lifecycle.phases.length ? null : h('p.note', {
          text: 'No phases recorded for this project, so there is no gate to sign. '
            + 'A project created from a template brings its phases with it.',
        }),
        h('div.phases', {
          style: { 'grid-template-columns': `repeat(${Math.min(6, data.lifecycle.phases.length || 1)}, 1fr)` },
        }, data.lifecycle.phases.map((ph) => {
          const cls = ph.state === 'blocked' ? 'blocked' : ph.done ? 'done' : ph.current ? 'current' : '';
          return h('div.phase' + (cls ? '.' + cls : ''), [
            h('div.bar'),
            h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '6px', 'margin-top': '8px' } }, [
              h('span.gate', { text: ph.gate }),
              h('span.name', { text: ph.name.toUpperCase() }),
            ]),
            h('div.criterion', { text: ph.criterion }),
            h('div.state', {
              text: ph.state === 'gate_met'
                ? `GATE MET${ph.gate_met_on ? ' ' + global.dom.shortDate(ph.gate_met_on) : ''}`
                : ph.state === 'current' ? 'CURRENT'
                  : ph.state === 'blocked' ? 'CRITERION UNDECIDED' : 'NOT ENTERED',
            }),
            ph.current || ph.state === 'blocked'
              ? h('button.btn.small', {
                style: { 'margin-top': '7px' },
                onclick: () => signGate(app, data, ph),
                text: 'SIGN ' + ph.gate,
              })
              : null,
          ]);
        })),
      ]),
    ]),

    kpi_strip: (app, data) => h('div.kpis', { style: { 'margin-bottom': '14px' } }, [
      kpi('Weighted readiness', `${data.kpis.readiness.pct}%`,
        `${data.kpis.completion.done} done · ${data.kpis.completion.partial} partial · `
        + `${data.kpis.completion.notStarted} not started`),
      kpi('Open work packages', String(data.kpis.open), `${data.kpis.closed} closed`, 'plain'),
      kpi('Story points', String(data.kpis.points), 'leaf work only — a parent never counts its children', 'ok'),
      kpi('Time booked', `${nf(data.kpis.hours.spent, '0')} / ${nf(data.kpis.hours.estimated, '0')} h`,
        'spent against estimate'),
    ]),

    status_breakdown: (app, data) => h('div.panel', [
      h('div.panel-head', [h('h2', { text: 'Work by status' })]),
      h('div.panel-body', [
        h('div.stack-bar', { style: { 'margin-bottom': '14px' } },
          data.statusBar.map((s) => h('i', {
            style: { width: pct(s.pct), background: s.colour },
            title: `${s.label} ${s.count}`,
          }))),
        ...data.statusRows.map((s) => h('div.row', {
          style: { cursor: 'pointer' },
          onclick: () => app.go('work', { project: data.project.id, status: s.code }),
        }, [
          h('span', {
            style: { width: '2px', height: '12px', 'border-radius': '1px', background: s.colour },
          }),
          h('span.tag', { style: { color: s.colour, 'min-width': '96px' }, text: s.label }),
          h('div.meter.thin', [h('i', { style: { width: pct(s.pct), background: s.colour } })]),
          h('span.value', { style: { 'min-width': '20px' }, text: String(s.count) }),
        ])),
        h('div.pill-row', {
          style: { 'margin-top': '14px', 'padding-top': '13px', 'border-top': '1px solid var(--line)' },
        }, data.typeRows.map((t) => h('button.pill', {
          onclick: () => app.go('work', { project: data.project.id, type: t.name }),
          text: `${t.name} ${t.count}`,
        }))),
      ]),
    ]),

    versions: (app, data) => h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Versions' }),
        h('div.spacer'),
        h('button.btn.small', { onclick: () => app.go('roadmap'), text: 'ROADMAP →' }),
      ]),
      h('div.panel-body.tight', [
        data.versions.length
          ? h('div.rows', data.versions.map((v) => h('div', { style: { padding: '9px 0' } }, [
            h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '9px', 'margin-bottom': '6px' } }, [
              key(v.code),
              h('span.grow', { style: { 'font-size': '12px' }, text: v.name }),
              h('span.tag.small', { text: `${v.count} WP · ${v.due_short}` }),
            ]),
            h('div.meter-row', [
              h('div.meter.thin', [h('i', {
                style: {
                  width: pct(v.readiness.pct),
                  background: v.readiness.pct > 66 ? 'var(--ok)' : 'var(--accent)',
                },
              })]),
              h('span.value', { text: `${v.readiness.pct}%` }),
            ]),
          ])))
          : h('div.empty', { text: 'no versions' }),
      ]),
    ]),

    members: (app, data) => h('div.panel', [
      h('div.panel-head', [h('h2', { text: 'Members & roles' })]),
      h('div.panel-body.tight', [
        h('div.rows', data.members.map((m) => h('div.row', {
          style: { 'align-items': 'center' },
        }, [
          avatar(m),
          h('div.grow', [
            h('div', {
              style: { 'font-size': '12px', color: m.kind === 'placeholder' ? 'var(--ink-6)' : 'var(--ink-3)' },
              text: m.name,
            }),
            h('div', {
              style: { font: '400 9.5px var(--font-label)', 'letter-spacing': '.09em', color: 'var(--ink-5)' },
              text: (m.roles || '').toUpperCase() + (m.kind === 'placeholder' ? ' · CANNOT SIGN IN' : ''),
            }),
          ]),
          h('span.tag.small', { text: m.capacity ? `${nf(m.capacity)} H/WK` : 'NO CAPACITY' }),
        ]))),
      ]),
    ]),

    activity: (app, data) => h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Recent activity' }),
        h('div.spacer'),
        h('button.btn.small', { onclick: () => app.go('activity'), text: 'ALL ACTIVITY →' }),
      ]),
      h('div.panel-body.tight', [
        h('div.rows', data.activity.map((a) => h('div.row', [
          h('span', {
            style: {
              width: '2px', height: '11px', 'border-radius': '1px', 'flex-shrink': '0',
              background: kindColour(a.kind),
            },
          }),
          h('div.grow', [
            h('div', { style: { 'font-size': '11.5px', color: 'var(--ink-3)' } }, [
              h('b', {
                style: { 'font-weight': '600', color: a.is_machine ? 'var(--sel)' : 'var(--ink)' },
                text: a.who,
              }),
              ` ${a.verb}`,
              a.target ? ' ' : null,
              a.target ? h('span.key', { text: a.target }) : null,
            ]),
            a.detail
              ? h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)', 'line-height': '1.55' }, text: a.detail })
              : null,
          ]),
          h('span.when', { text: a.when }),
        ]))),
      ]),
    ]),
  };

  function kindColour(kind) {
    return {
      ai: 'var(--sel)', gate: 'var(--ok)', repo: 'var(--ok)', mention: 'var(--accent)',
      automation: 'var(--sel)', share: 'var(--accent)', baseline: 'var(--accent)',
    }[kind] || 'var(--ink-5)';
  }

  // ------------------------------------------------------------------- actions

  function signGate(app, data, phase) {
    const note = prompt(
      `Sign ${phase.gate} — ${data.project.code}\n\nCriterion: ${phase.criterion}\n\n`
      + 'A gate is recorded with a date and a person. Add a note (optional):',
      ''
    );
    if (note === null) return;
    app.act(
      () => global.api.post(`/api/projects/${data.project.id}/gates/${phase.id}`, { note: note || null }),
      `${phase.gate} recorded as met`
    );
  }

  function takeBaseline(app, data) {
    const name = prompt(
      'A baseline is a copy of every date, status and point total as of now. '
      + 'Slip is measured against it and cannot be edited away.\n\nName it:',
      `Baseline ${data.project.code} ${new Date().toISOString().slice(0, 10)}`
    );
    if (!name) return;
    app.act(
      () => global.api.post(`/api/projects/${data.project.id}/baseline`, { name }),
      'Baseline taken'
    );
  }

  function setHealth(app, data) {
    const health = prompt(
      'Project health is a judgement you record, not a number derived from the schedule.\n\n'
      + 'green · amber · rust · off',
      data.project.health
    );
    if (!health) return;
    const note = prompt('One line saying why:', data.project.health_note || '') || '';
    app.act(
      () => global.api.post(`/api/projects/${data.project.id}/health`, { health: health.trim(), note }),
      'Health recorded'
    );
  }

  global.overviewKindColour = kindColour;
}(window));
