/*
 * The team planner: booked hours against declared capacity, per person per week.
 *
 * A placeholder user gets a row like anyone else. That is the point of a
 * placeholder: it holds work before a person exists, so the milestone it owns
 * has an owner before the hire happens. Its row is dimmed and says CANNOT SIGN
 * IN, and hours booked against no declared capacity are shown as exactly that
 * rather than as an over-capacity warning — the plan is real, the person is not
 * hired yet, and those are different problems.
 */

(function (global) {
  'use strict';

  const { h, nf, pct, avatar } = global.dom;

  global.viewPlanner = async function viewPlanner(app) {
    const weeks = app.state.params.weeks || 6;
    const data = await global.api.get(`/api/planner${global.api.qs({ weeks, from: app.state.params.from })}`);
    const over = data.rows.flatMap((r) => r.cells.filter((c) => c.state === 'over'));

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Team planner' }),
        h('div.page-sub', {
          text: over.length
            ? `booked hours against declared capacity · ${over.length} week-person(s) over capacity`
            : 'booked hours against declared capacity · nobody is over capacity',
        }),
        h('div.spacer'),
        h('div.pill-row', [6, 8, 12].map((n) => h('button.pill' + (Number(weeks) === n ? '.is-on' : ''), {
          onclick: () => app.setParam('weeks', n),
          text: `${n} WEEKS`,
        }))),
      ]),

      h('div.panel', [
        h('div.planner-head', {
          style: { '--weeks': data.weeks.length },
        }, [
          h('div', { text: 'Person' }),
          ...data.weeks.map((w) => h('div', { text: w.label })),
        ]),
        ...data.rows.map((r) => h('div.planner-row', { style: { '--weeks': data.weeks.length } }, [
          h('div.planner-person', [
            avatar(r, { big: true }),
            h('div.who', [
              h('b', {
                style: r.kind === 'placeholder' ? { color: 'var(--ink-6)' } : null,
                title: r.name,
                text: r.name,
              }),
              h('span', {
                text: r.kind === 'placeholder'
                  ? `PLACEHOLDER · CANNOT SIGN IN`
                  : `${(r.roles || '').toUpperCase()} · ${nf(r.capacity, '0')} H/WK`,
              }),
            ]),
          ]),
          ...r.cells.map((c) => h('div.planner-cell.load-' + c.state, [
            h('div.meter.thin', { style: { 'margin-bottom': '6px' } }, [
              h('i', { style: { width: pct(c.pct) } }),
            ]),
            h('button.hours', {
              style: { background: 'none', border: 'none', padding: '0', cursor: 'pointer', color: 'inherit' },
              title: c.capacity
                ? `${nf(c.booked, '0')} booked of ${nf(c.capacity)} — click to change`
                : 'no declared capacity — click to book anyway',
              onclick: () => book(app, r, c),
              text: c.booked ? nf(c.booked) : '·',
            }),
          ])),
        ])),
      ]),

      h('p.note', {
        text: 'A placeholder user holds a seat without an account: assignable, schedulable, cannot sign '
          + 'in. Converting one to a real account keeps every assignment and comment attached. Hours '
          + 'booked against nobody with declared capacity are shown as booked, not as over capacity — '
          + 'the plan is real, the hire has not happened.',
      }),
    ]);
  };

  function book(app, person, cell) {
    const value = prompt(
      `${person.name} — week of ${cell.week_start}\n\n`
      + `Booked: ${nf(cell.booked, '0')} h`
      + (cell.capacity ? ` of ${nf(cell.capacity)} h declared` : ' (no declared capacity)')
      + '\n\nNew booking in hours (0 removes it):',
      String(cell.booked || 0)
    );
    if (value === null) return;
    app.act(
      () => global.api.post('/api/allocations', {
        user_id: person.id, week_start: cell.week_start, hours: Number(value),
      }),
      'Booking recorded'
    );
  }
}(window));
