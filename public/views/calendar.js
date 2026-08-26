/*
 * The calendar.
 *
 * Weekends and holidays are SHADED, not hidden. The work week definition is
 * scheduling arithmetic — it decides how many days an estimate spans — and has
 * nothing to say about what a person is allowed to look at. A calendar that hid
 * non-working days would make a due date on a Saturday invisible rather than
 * wrong, which is the worse of the two.
 *
 * The iCal feed carries the same events, so a date alert fires whether or not
 * this page is open.
 */

(function (global) {
  'use strict';

  const { h, key } = global.dom;

  global.viewCalendar = async function viewCalendar(app) {
    const month = app.state.params.month || null;
    const data = await global.api.get(`/api/calendar${global.api.qs({ project: app.state.project, month })}`);

    return h('div.page', [
      h('div.page-head', [
        h('div.page-title', { text: data.monthLabel }),
        h('div.page-sub', {
          text: `due dates, meetings and sprint starts · work week ${data.workWeek}`,
        }),
        h('div.spacer'),
        h('button.btn', { onclick: () => app.setParam('month', data.prev), text: '← ' + data.prev }),
        h('button.btn', { onclick: () => app.setParam('month', null), text: 'TODAY' }),
        h('button.btn', { onclick: () => app.setParam('month', data.next), text: data.next + ' →' }),
        data.subscription
          ? h('a.btn.sel', {
            href: data.subscription.url,
            title: data.subscription.name,
            text: 'SUBSCRIBE · ICAL',
          })
          : null,
      ]),

      h('div.panel', [
        h('div.cal-head', data.dows.map((d) => h('div', { text: d }))),
        h('div.cal-grid', data.cells.map((c) => cell(app, c))),
      ]),

      h('p.note', {
        text: 'Weekends and holidays are shaded, not hidden — the work week definition only affects '
          + 'scheduling arithmetic, not what you can see. The iCal feed is read-only and carries the '
          + 'same events, so a date alert fires whether or not this page is open.',
      }),
    ]);
  };

  function cell(app, c) {
    const classes = ['cal-cell'];
    if (!c.working) classes.push('nonworking');
    if (!c.inMonth) classes.push('out');
    if (c.isToday) classes.push('today');
    return h('div', { class: classes.join(' ') }, [
      h('div.day', { text: String(c.day) }),
      ...c.events.slice(0, 4).map((e) => h('div.cal-event', {
        style: { 'border-left-color': e.colour },
        title: e.text,
        onclick: () => {
          if (e.work_package_id) app.openWp(e.work_package_id);
          else if (e.meeting_id) app.go('meetings', { project: app.state.project, meeting: e.meeting_id });
          else if (e.sprint_id) app.go('backlogs', { project: app.state.project });
        },
        text: e.text,
      })),
      c.events.length > 4
        ? h('div.cal-event', {
          style: { 'border-left-color': 'var(--ink-6)', color: 'var(--ink-5)' },
          text: `+${c.events.length - 4} more`,
        })
        : null,
    ]);
  }
}(window));
