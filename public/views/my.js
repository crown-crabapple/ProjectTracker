/*
 * My page.
 *
 * Everything assigned to, accountable to, or watched by the signed-in person,
 * across every project they can see. The three-role model is why this is one
 * view rather than "my assignments": a thing you are accountable for and a thing
 * you are watching both belong on the page you open first.
 */

(function (global) {
  'use strict';

  const { h, kpi, meter, tag, key, nf, pct } = global.dom;

  global.viewMy = async function viewMy(app) {
    const data = await global.api.get('/api/my');
    const k = data.kpis;

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'My page' }),
        h('div.page-sub', {
          text: `${longDate(data.today)} · everything assigned to, accountable to or watched by you,`
            + ` across ${app.boot.projects.length} project${app.boot.projects.length === 1 ? '' : 's'}`,
        }),
      ]),

      h('div.kpis', [
        kpi('Open work involving me', String(k.assigned), k.assignedSub),
        kpi('Due this week', String(k.dueThisWeek), k.dueSub, k.dueThisWeek ? 'blocked' : 'plain'),
        // Booked against declared availability. Amber at or over capacity, and
        // the subtitle names the denominator — a bare "34" tells you nothing.
        kpi('Booked this week', `${nf(k.bookedThisWeek, '0')}`,
          `of ${nf(k.capacity, '0')} h declared availability`,
          k.capacity && k.bookedThisWeek > k.capacity ? 'blocked' : undefined),
        kpi('Story points in flight', String(k.points), k.pointsSub, 'ok'),
      ]),

      h('div.grid.c2-wide', [
        workPanel(app, data),
        h('div.stack', [
          data.summary ? summaryPanel(app, data.summary) : null,
          alertsPanel(app, data),
          availabilityPanel(data),
        ]),
      ]),
    ]);
  };

  function workPanel(app, data) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'My work' }),
        h('div.spacer'),
        h('button.btn.small', {
          onclick: () => app.go('work', { project: app.state.project, involves: '1' }),
          text: 'ALL WORK PACKAGES →',
        }),
      ]),
      data.work.length
        ? h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'ID' }), h('th', { text: 'Subject' }), h('th', { text: 'Project' }),
            h('th', { text: 'Status' }), h('th.r', { text: 'Due' }),
          ])]),
          h('tbody', data.work.map((w) => h('tr.clickable', {
            onclick: () => app.openWp(w.id),
            // The full shorthand: setting only the colour leaves the width at 0
            // and the highlight never appears.
            style: { 'border-left': `2px solid ${w.highlight || 'transparent'}` },
          }, [
            h('td', { 'data-label': 'ID' }, [key(w.key)]),
            h('td', { 'data-label': 'Subject', text: w.subject }),
            h('td.dim', { 'data-label': 'Project', text: w.project_code }),
            h('td', { 'data-label': 'Status' }, [tag(w.status_label, w.status_colour)]),
            h('td.r', { 'data-label': 'Due' }, [
              h('span.tag', {
                style: { color: w.overdue ? 'var(--blocked)' : 'var(--ink-3)' },
                text: w.due_short,
              }),
            ]),
          ]))),
        ])])
        : h('div.empty', { text: 'nothing assigned, accountable or watched' }),
    ]);
  }

  /**
   * The generated summary.
   *
   * Cyan-bordered and labelled GENERATED, with its age and its source, because
   * prose a machine wrote and prose a person wrote must not look the same. The
   * REGENERATE button is deliberately absent when there is no write-scoped MCP
   * token: a button that always fails is worse than no button.
   */
  function summaryPanel(app, summary) {
    return h('div.panel.raised', {
      style: { 'border-color': 'rgba(95,184,200,.22)' },
    }, [
      h('div.panel-head', [
        h('span.dot', { style: { width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--sel)' } }),
        h('h2', { text: 'Status summary · generated' }),
      ]),
      h('div.panel-body', [
        ...global.md.render(summary.body),
        h('div.row', [
          h('span.panel-note', {
            text: `WRITTEN ${String(summary.age).toUpperCase()} AGO · ${String(summary.source).toUpperCase()}`
              + (summary.token_name ? ` · ${summary.token_name.toUpperCase()}` : ''),
          }),
        ]),
      ]),
    ]);
  }

  function alertsPanel(app, data) {
    const firing = data.alerts.filter((a) => a.severity !== 'later').length;
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Date alerts' }),
        h('div.spacer'),
        h('span.panel-note', {
          style: { color: firing ? 'var(--blocked)' : 'var(--ink-5)' },
          text: `${firing} FIRING`,
        }),
      ]),
      h('div.panel-body.tight', [
        data.alerts.length
          ? h('div.rows', data.alerts.map((a) => h('div.row.clickable', {
            onclick: () => a.work_package_id && app.openWp(a.work_package_id),
          }, [
            a.wp_key ? key(a.wp_key) : null,
            h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-3)' }, text: a.text }),
            h('span.tag.small', {
              style: { color: a.severity === 'overdue' ? 'var(--blocked)' : a.severity === 'soon' ? 'var(--accent)' : 'var(--ink-5)' },
              text: a.when,
            }),
          ])))
          : h('div.empty', { text: 'no date alerts' }),
        h('div.row', [
          h('button.btn.small', {
            onclick: () => app.act(() => global.api.post('/api/alerts/run'), 'Date alert rules re-evaluated'),
            text: 'RUN THE RULES NOW',
          }),
        ]),
      ]),
    ]);
  }

  /**
   * Six weeks of booked hours against declared availability.
   *
   * The bar's colour is the load state the server computed, not a threshold
   * recomputed here: two places deciding what "over capacity" means is two
   * places to get it wrong.
   */
  function availabilityPanel(data) {
    const over = data.weeks.filter((w) => w.state === 'over');
    return h('div.panel', [
      h('div.panel-head', [h('h2', { text: 'My availability · next six weeks' })]),
      h('div.panel-body', [
        h('div.bars', {
          style: { 'grid-template-columns': `repeat(${data.weeks.length}, 1fr)` },
        }, data.weeks.map((w) => h('div.col.load-' + w.state, [
          h('div.cap', { style: { 'margin-top': '0', 'margin-bottom': '5px' }, text: w.label }),
          h('div.well', { style: { height: '52px' } }, [h('i', { style: { height: pct(w.pct) } })]),
          h('div.val', { text: `${nf(w.booked, '0')} H` }),
        ]))),
        h('p.note', {
          text: data.kpis.capacity
            ? `Booked hours against ${nf(data.kpis.capacity)} h declared availability. `
              + (over.length
                ? `${over.length} week${over.length === 1 ? ' is' : 's are'} over capacity.`
                : 'No week is over capacity.')
            : 'You have no declared weekly capacity, so these are booked hours with nothing to compare against.',
        }),
      ]),
    ]);
  }

  const DOWS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /** 'Wednesday 26 August 2026'. Built by hand from the ISO parts rather than
   *  via Date, so it cannot shift a day in a western timezone. */
  function longDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${DOWS[dow]} ${d} ${MONTHS[m - 1]} ${y}`;
  }
}(window));
