/*
 * The roadmap: every version in the portfolio on one timeline.
 *
 * A version with no due date is drawn in the list as UNSCHEDULED and has no
 * marker on the timeline. That is deliberate: putting an unscheduled version at
 * the far right would read as "scheduled for later", and the difference between
 * "later" and "not decided" is the thing a roadmap exists to show.
 */

(function (global) {
  'use strict';

  const { h, key, pct, nf } = global.dom;

  global.viewRoadmap = async function viewRoadmap(app) {
    const data = await global.api.get('/api/roadmap');
    if (!data.versions.length) {
      return h('div.page', [
        h('div.page-head', [h('div.page-title', { text: 'Roadmap' })]),
        h('div.panel', h('div.empty', { text: 'no versions in any project you can see' })),
      ]);
    }
    const unscheduled = data.versions.filter((v) => !v.due_date);

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Roadmap' }),
        h('div.page-sub', {
          text: `every version in the portfolio, on one timeline · ${monthLabel(data.t0)} to ${monthLabel(data.t1)}`,
        }),
      ]),

      h('div.panel', { style: { 'margin-bottom': '14px' } }, [
        h('div', { style: { display: 'grid', 'grid-template-columns': '300px minmax(0,1fr)' } }, [
          h('div', { style: { 'border-right': '1px solid var(--line)' } }, [
            h('div', {
              style: {
                height: '26px', 'border-bottom': '1px solid var(--line)', display: 'flex',
                'align-items': 'flex-end', padding: '0 14px 5px',
              },
            }, [h('div.label', { text: 'Version' })]),
            ...data.versions.map((v) => h('div', {
              style: {
                height: '40px', display: 'flex', 'align-items': 'center', gap: '9px',
                padding: '0 14px', 'border-bottom': '1px solid var(--line-2)', cursor: 'pointer',
              },
              onclick: () => app.go('work', { project: v.id ? projectIdFor(app, v) : null, version: v.code }),
            }, [
              h('span.tag.small', { style: { 'min-width': '34px' }, text: v.project_code }),
              h('span', {
                style: {
                  flex: '1', 'min-width': '0', 'font-size': '12px', color: 'var(--ink-2)',
                  overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap',
                },
                text: v.name,
              }),
              h('span.tag.small', {
                style: { color: v.overdue ? 'var(--blocked)' : v.due_date ? 'var(--ink-5)' : 'var(--ink-6)' },
                text: v.due_short,
              }),
            ])),
          ]),
          h('div', { style: { position: 'relative', 'min-width': '0' } }, [
            h('div.gantt-months', { style: { height: '26px' } }, data.months.map((m) => h('div', {
              style: { width: pct(m.widthPct), padding: '6px 0 0 7px' }, text: m.label,
            }))),
            data.todayPct === null ? null : h('div.gantt-today', {
              style: { top: '26px', left: pct(data.todayPct) },
            }),
            ...data.versions.map((v) => h('div', {
              style: {
                height: '40px', 'border-bottom': '1px solid var(--line-2)', position: 'relative',
              },
            }, [
              h('div', {
                style: {
                  position: 'absolute', left: '0', right: '0', top: '19px', height: '1px',
                  background: 'rgba(255,255,255,.05)',
                },
              }),
              v.markPct === null ? null : h('div', {
                style: {
                  position: 'absolute', top: '14px', left: pct(v.markPct),
                  width: '11px', height: '11px', 'border-radius': '2px',
                  transform: 'rotate(45deg)',
                  background: v.readiness.pct > 66 ? 'var(--ok)' : v.readiness.pct > 20 ? 'var(--accent)' : 'var(--ink-6)',
                },
                title: `${v.project_code} ${v.code} · due ${v.due_date} · ${v.readiness.pct}% ready`,
              }),
            ])),
          ]),
        ]),
      ]),

      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Version progress' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'WEIGHTED READINESS, NOT COMPLETION' }),
        ]),
        h('div.panel-body', [
          h('div.rows', data.versions.map((v) => h('div', { style: { padding: '11px 0' } }, [
            h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '9px', 'margin-bottom': '7px' } }, [
              key(`${v.project_code} ${v.code}`),
              h('span.grow', { style: { 'font-size': '12.5px' }, text: v.name }),
              h('span.tag.small', {
                text: `${v.count} WP · ${v.closed} CLOSED · ${v.points} PTS`
                  + (v.state !== 'open' ? ` · ${v.state.toUpperCase()}` : ''),
              }),
            ]),
            h('div.meter-row', [
              h('div.meter', [h('i', {
                style: {
                  width: pct(v.readiness.pct),
                  background: v.readiness.pct > 66 ? 'var(--ok)' : v.readiness.pct > 20 ? 'var(--accent)' : 'var(--ink-6)',
                },
              })]),
              h('span.value', { text: `${v.readiness.pct}%` }),
            ]),
          ]))),
        ]),
      ]),

      unscheduled.length
        ? h('p.note', {
          text: `${unscheduled.length} version(s) have no due date and so have no marker on the timeline: `
            + `${unscheduled.map((v) => `${v.project_code} ${v.code}`).join(', ')}. `
            + 'Drawing them at the far right would read as "scheduled for later", and the difference '
            + 'between later and undecided is what a roadmap is for.',
        })
        : null,
    ]);
  };

  function projectIdFor(app, v) {
    const p = app.boot.projects.find((x) => x.code === v.project_code);
    return p ? p.id : null;
  }

  function monthLabel(iso) {
    const [y, m] = iso.split('-').map(Number);
    return `${global.dom.MONTHS[m - 1]} ${y}`;
  }
}(window));
