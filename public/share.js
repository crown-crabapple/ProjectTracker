/*
 * The share page.
 *
 * One fetch, one render, no session, no cookie, no write path. The two things it
 * says out loud are the two a recipient needs to know: that internal comments are
 * never included in a share, and when the link expires.
 */

(function (global) {
  'use strict';

  const { h, fill, key, tag, nf } = global.dom;

  function parse() {
    const parts = location.pathname.split('/').filter(Boolean);
    // /share/<token>  or  /share/list/<token>
    if (parts[1] === 'list') return { kind: 'list', token: parts[2] };
    return { kind: 'wp', token: parts[1] };
  }

  async function main() {
    const view = document.getElementById('view');
    const { kind, token } = parse();
    if (!token) return fill(view, panel('That link is incomplete.', 'There is no token in the URL.'));

    let data;
    try {
      data = await global.api.get(kind === 'list' ? `/api/list-share/${token}` : `/api/share/${token}`);
    } catch (e) {
      return fill(view, panel('This link does not work', e.message));
    }

    document.getElementById('expiry').textContent = data.expires_at
      ? `EXPIRES ${String(data.expires_at).slice(0, 10)}`
      : 'NO EXPIRY';

    if (data.kind === 'list') return renderList(view, data);
    return renderWorkPackage(view, data);
  }

  function panel(title, body) {
    return h('div.page', [
      h('div.panel', [
        h('div.panel-head', [h('h2', { text: title })]),
        h('div.panel-body', [h('p', { text: body })]),
      ]),
    ]);
  }

  function renderWorkPackage(view, data) {
    const w = data.wp;
    document.getElementById('crumb').textContent =
      `SHARED BY LINK / ${w.project_code} / ${w.key}`;
    document.title = `${w.key} ${w.subject}`;

    fill(view, h('div.page', [
      h('div.page-head.baseline', [
        key(w.key),
        h('span.type-tag', { style: { color: w.type_colour, margin: '0' }, text: w.type }),
        h('div.page-title', { text: w.subject }),
      ]),

      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: `${w.project_code} · ${w.project_name}` }),
          h('div.spacer'),
          h('span.panel-note', { text: `${data.permission.toUpperCase()} ACCESS` }),
        ]),
        h('div.panel-body', [
          h('dl.field-grid', [
            h('dt', { text: 'STATUS' }), h('dd', [tag(w.status_label, w.status_colour)]),
            h('dt', { text: 'PRIORITY' }), h('dd', [tag(w.priority_label, w.priority_colour)]),
            h('dt', { text: 'ASSIGNEE' }), h('dd', { text: w.assignee || 'nobody' }),
            h('dt', { text: 'ACCOUNTABLE' }), h('dd', { text: w.accountable || 'nobody' }),
            h('dt', { text: 'DATES' }),
            h('dd', {
              style: { color: w.overdue ? 'var(--blocked)' : 'var(--ink-3)' },
              text: w.dates,
            }),
            h('dt', { text: 'VERSION' }), h('dd', { text: w.version || '—' }),
            h('dt', { text: 'SPRINT' }), h('dd', { text: w.sprint || 'backlog' }),
            h('dt', { text: 'POINTS' }),
            h('dd', { text: w.story_points === null ? 'not estimated' : String(w.story_points) }),
            h('dt', { text: 'ESTIMATE' }),
            h('dd', { text: w.estimated_hours ? `${nf(w.estimated_hours)} h` : 'no estimate' }),
          ]),
        ]),
      ]),

      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Comments' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'INTERNAL COMMENTS ARE NEVER SHARED' }),
        ]),
        h('div.panel-body', [
          data.comments.length
            ? h('div', data.comments.map((c) => h('div.comment', [
              h('div.top', [
                h('span.who', { text: c.author || 'somebody' }),
                h('div.spacer'),
                h('span.when', { text: `${c.when} AGO` }),
              ]),
              h('div.body', { text: c.body }),
            ])))
            : h('div.empty', { text: 'no comments' }),
        ]),
      ]),

      h('p.note', { text: data.note }),
    ]));
  }

  function renderList(view, data) {
    document.getElementById('crumb').textContent = `SHARED BY LINK / ${data.name.toUpperCase()}`;
    document.title = data.name;
    fill(view, h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: data.name }),
        h('div.page-sub', { text: `shared by ${data.shared_by}` }),
      ]),
      h('div.kpis', { style: { 'margin-bottom': '14px' } }, [
        global.dom.kpi('Projects', String(data.kpis.projects), data.kpis.projectsSub),
        global.dom.kpi('Weighted readiness', `${data.kpis.readiness.pct}%`,
          `over ${data.kpis.readiness.scored} scored · ${data.kpis.readiness.excluded} excluded`),
        global.dom.kpi('Open work packages', String(data.kpis.open), data.kpis.openSub, 'plain'),
        global.dom.kpi('Gates awaiting a decision', String(data.kpis.gatesBlocked),
          data.kpis.gatesBlockedSub, data.kpis.gatesBlocked ? 'blocked' : 'plain'),
      ]),
      ...data.programs.map((program) => h('div.panel', { style: { 'margin-bottom': '14px' } }, [
        h('div.panel-head', [
          program.code ? key(program.code) : null,
          h('div', { style: { font: '600 12.5px var(--font-prose)' }, text: program.name }),
        ]),
        h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'Project' }), h('th', { text: 'Readiness' }),
            h('th.r', { text: 'Open' }), h('th', { text: 'Next gate' }),
          ])]),
          h('tbody', program.projects.map((p) => h('tr', [
            h('td', { 'data-label': 'Project' }, [
              h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'baseline' } }, [
                key(p.code), h('span', { text: p.name }),
              ]),
            ]),
            h('td', { 'data-label': 'Readiness' }, [
              global.dom.meter(p.readiness.pct,
                p.health === 'rust' ? 'var(--blocked)' : p.health === 'green' ? 'var(--ok)' : 'var(--accent)',
                `${p.readiness.pct}%`),
            ]),
            h('td.r', { 'data-label': 'Open', text: String(p.open) }),
            h('td', { 'data-label': 'Next gate' }, [
              p.next_gate
                ? tag(p.next_gate.gate ? `${p.next_gate.gate} ${p.next_gate.phase.toUpperCase()}` : 'SHIPPED',
                  p.next_gate.blocked ? 'var(--blocked)' : 'var(--ink-5)', true)
                : tag('—', 'var(--ink-6)', true),
            ]),
          ]))),
        ])]),
      ])),
      h('p.note', { text: data.note }),
    ]));
  }

  // Started once, whichever path gets there first.
  let started = false;
  const startOnce = () => { if (!started) { started = true; main(); } };
  document.addEventListener('DOMContentLoaded', startOnce);
  if (document.readyState !== 'loading') startOnce();
}(window));
