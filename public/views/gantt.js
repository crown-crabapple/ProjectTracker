/*
 * The Gantt.
 *
 * Bars are coloured by status, so the chart reads the same way as every table —
 * a chart with its own palette is a chart you have to learn separately.
 *
 * The hollow bar is the baseline: what the plan was signed off against. A bar to
 * the right of its hollow one has slipped, and the drawer says by how many days.
 * The baseline is a stored copy and is never recomputed, so a slip cannot be
 * edited away by correcting history.
 */

(function (global) {
  'use strict';

  const { h, key, pct, nf } = global.dom;

  global.viewGantt = async function viewGantt(app) {
    const data = await global.api.get(`/api/gantt${global.api.qs({ project: app.state.project })}`);
    if (!data.rows.length) {
      return h('div.page', [
        h('div.page-head', [h('div.page-title', { text: 'Gantt' })]),
        h('div.panel', h('div.empty', { text: 'nothing in this project has dates yet' })),
      ]);
    }

    const slipped = data.rows.filter((r) => r.baseline && r.baseline.slip > 0);

    return h('div.page.wide', [
      h('div.page-head', [
        h('div.page-title', { text: 'Gantt' }),
        h('div.page-sub', {
          text: `${data.t0} to ${data.t1} · today ${global.dom.shortDate(app.boot.today)}`
            + (data.baseline ? ` · baseline "${data.baseline.name}" shown hollow` : ' · no baseline taken'),
        }),
        h('div.spacer'),
        h('button.btn', {
          onclick: () => app.act(
            () => global.api.post(`/api/projects/${app.state.project}/reschedule`, { apply: true }),
            'Automatic dates re-derived'
          ),
          title: 'Re-derive every automatically scheduled date from children and predecessors',
          text: 'RESCHEDULE',
        }),
        h('button.btn', { onclick: () => preview(app), text: 'PREVIEW A RESCHEDULE' }),
      ]),

      h('div.panel', [
        h('div.gantt', [
          h('div.gantt-left', [
            h('div.head', [h('div.label', { text: 'Work package' })]),
            ...data.rows.map((r) => h('div.gantt-row', {
              onclick: () => app.openWp(r.id),
              style: { 'padding-left': `${12 + r.depth * 16}px` },
            }, [
              h('span.id', { text: r.key }),
              h('span.subject', { title: r.subject, text: r.subject }),
              h('span.sched' + (r.scheduling === 'manual' ? '.manual' : ''), {
                title: r.scheduling === 'manual'
                  ? 'Holds its own dates'
                  : 'Derived from its children and predecessors',
                text: r.scheduling === 'manual' ? 'MANUAL' : 'AUTO',
              }),
            ])),
          ]),
          h('div.gantt-right', [
            h('div.gantt-months', data.months.map((m) => h('div', {
              style: { width: pct(m.widthPct) }, text: m.label,
            }))),
            h('div.gantt-weeks', data.weeks.map((w) => h('div', {
              // The server sizes each week by the days it covers, so the
              // gridlines land on the month boundaries and on the bars.
              style: { width: pct(w.widthPct) }, text: w.label,
            }))),
            data.todayPct === null ? null : h('div.gantt-today', { style: { left: pct(data.todayPct) } }),
            ...data.rows.map((r) => h('div.gantt-track', [
              r.baseline && r.baseline.leftPct !== null
                ? h('div.gantt-base', {
                  style: { left: pct(r.baseline.leftPct), width: pct(r.baseline.widthPct) },
                  title: `baseline ${r.baseline.baselineStart} → ${r.baseline.baselineDue}`,
                })
                : null,
              // No dates, no bar. Drawing one at the left edge would read as
              // "starts at the beginning of the plan", which is a claim.
              r.undated
                ? h('div', {
                  style: {
                    position: 'absolute', top: '11px', left: '8px',
                    font: '500 8.5px var(--font-label)', 'letter-spacing': '.1em',
                    color: 'var(--ink-6)',
                  },
                  text: 'NO DATES',
                })
                : h('div.gantt-bar' + (r.is_milestone ? '.milestone' : ''), {
                  style: {
                    left: pct(r.leftPct),
                    width: r.is_milestone ? '11px' : pct(r.widthPct),
                    background: r.is_milestone ? 'var(--sel)' : r.status_colour,
                  },
                  title: `${r.key} ${r.subject}\n${r.dates}\n${r.status_label}`
                    + (r.baseline && r.baseline.slip ? `\nslipped ${r.baseline.slip} day(s)` : ''),
                  onclick: () => app.openWp(r.id),
                }),
            ])),
          ]),
        ]),
      ]),

      slipped.length
        ? h('div.panel', [
          h('div.panel-head', [
            h('h2', { text: 'Slip against the baseline' }),
            h('div.spacer'),
            h('span.panel-note', { text: 'RECORDED, NOT ABSORBED' }),
          ]),
          h('div.panel-body.tight', [
            h('div.rows', slipped
              .sort((a, b) => b.baseline.slip - a.baseline.slip)
              .map((r) => h('div.row.clickable', { onclick: () => app.openWp(r.id) }, [
                key(r.key),
                h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-3)' }, text: r.subject }),
                h('span.tag.small', {
                  style: { color: 'var(--blocked)' },
                  text: `${r.baseline.slip} DAY${r.baseline.slip === 1 ? '' : 'S'} LATE`,
                }),
              ]))),
          ]),
        ])
        : null,

      h('p.note', {
        text: 'Bars are coloured by status, so the chart reads the same way as every table. Hollow bars '
          + 'are the baseline the plan was signed off against. MANUAL rows hold their own dates; AUTO '
          + 'rows are derived from their children and their predecessors, and rescheduling moves them.',
      }),
    ]);
  };

  /**
   * Preview mode: ask the server what a reschedule would move, and say so,
   * without writing. The point is that a plan change is visible before it
   * happens — "this will move four other things" is the sentence somebody needs
   * before they agree to it.
   */
  async function preview(app) {
    try {
      const out = await global.api.post(`/api/projects/${app.state.project}/reschedule`, { apply: false });
      if (!out.changed.length) return app.toast('Every automatic date is already where it should be.', 'good');
      const lines = out.changed.slice(0, 6)
        .map((c) => `WP-${c.id} → ${c.start_date} … ${c.due_date} (${c.reason})`).join('\n');
      return app.toast(
        `${out.changed.length} would move.\n${lines}`
        + (out.converged ? '' : '\nThe relations did not settle — check for a loop.'),
        out.converged ? undefined : 'bad'
      );
    } catch (e) {
      return app.toast(e.message, 'bad');
    }
  }
}(window));
