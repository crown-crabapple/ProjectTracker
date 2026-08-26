/*
 * Meetings: agendas, minutes and what came out of them.
 *
 * The agenda freezes when the meeting opens; after that, edits go to the
 * minutes. That is a state on the meeting rather than a pair of booleans, and
 * the ADD ITEM control disappears rather than failing — a control that always
 * errors teaches people to stop trusting the screen.
 *
 * A carried-forward item is kept as an outcome pointing at the next meeting,
 * because "we did not decide" is an outcome worth keeping and an unclosed action
 * nobody named is how it gets lost.
 */

(function (global) {
  'use strict';

  const { h, key } = global.dom;

  global.viewMeetings = async function viewMeetings(app) {
    const meetingId = app.state.params.meeting || null;
    const data = await global.api.get(`/api/meetings${global.api.qs({ project: app.state.project, meeting: meetingId })}`);

    return h('div.page', [
      h('div.page-head', [
        h('div.page-title', { text: 'Meetings' }),
        h('div.spacer'),
        h('button.btn.primary', { onclick: () => app.toast('Creating a meeting is not in this build — the API accepts agenda items and minutes on the seeded meetings.'), text: 'NEW MEETING' }),
      ]),

      h('div.grid.c2', { style: { 'grid-template-columns': '300px minmax(0,1fr)', 'margin-top': '0' } }, [
        h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'Schedule' })]),
          h('div.panel-body.tight', [
            data.list.length
              ? h('div.rows', data.list.map((m) => h('div.row.clickable', {
                style: { display: 'block', padding: '11px 0' },
                onclick: () => app.setParam('meeting', m.id),
              }, [
                h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
                  h('span.grow', {
                    style: {
                      'font-size': '12.5px',
                      color: data.current && data.current.id === m.id ? 'var(--accent)' : 'var(--ink-4)',
                    },
                    text: m.title,
                  }),
                  h('span.tag.small', {
                    style: { color: m.has_minutes ? 'var(--ok)' : 'var(--sel)' },
                    text: m.has_minutes ? 'MINUTES' : m.state.toUpperCase(),
                  }),
                ]),
                h('div', {
                  style: { font: '400 9.5px var(--font-label)', 'letter-spacing': '.09em', color: 'var(--ink-5)', 'margin-top': '3px' },
                  text: `${m.dateLabel} · ${m.start_time} · ${m.duration_min}M${m.project_code ? ' · ' + m.project_code : ''}`,
                }),
                h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '2px' }, text: m.who || '' }),
              ])))
              : h('div.empty', { text: 'no meetings' }),
          ]),
        ]),

        data.current ? detail(app, data.current) : h('div.panel', h('div.empty', { text: 'pick a meeting' })),
      ]),
    ]);
  };

  function detail(app, m) {
    const planned = m.agenda.reduce((a, i) => a + (Number(i.duration_min) || 0), 0);
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: m.title }),
        h('div.spacer'),
        h('span.panel-note', {
          style: { color: m.agendaOpen ? 'var(--sel)' : 'var(--ink-5)' },
          text: m.agendaOpen ? 'AGENDA OPEN' : 'AGENDA FROZEN',
        }),
      ]),
      h('div.panel-body', [
        h('div.crumb', {
          text: `${m.dateLabel} · ${m.duration_min}M · ${(m.who || '').toUpperCase()}`
            + (planned ? ` · ${planned}M PLANNED` : ''),
        }),

        h('div.drawer-section', { text: 'Agenda' }),
        m.agenda.length
          ? h('div.rows', m.agenda.map((i) => h('div.row', [
            h('span.tag.small', { style: { 'min-width': '52px' }, text: i.duration_min ? `${i.duration_min} MIN` : '—' }),
            h('span.grow', { style: { 'font-size': '12.5px', color: 'var(--ink-3)' }, text: i.title }),
            i.wp_key
              ? h('button.key', {
                style: { border: 'none', cursor: 'pointer' },
                onclick: () => app.openWp(i.work_package_id),
                text: i.wp_key,
              })
              : null,
          ])))
          : h('div.empty', { text: 'no agenda items' }),
        m.agendaOpen
          ? h('button.btn.small', {
            style: { 'margin-top': '10px' },
            onclick: () => addItem(app, m),
            text: '+ AGENDA ITEM',
          })
          : h('p.note', {
            style: { margin: '10px 0 0' },
            text: 'This agenda is frozen because the meeting has opened. Anything new belongs in the minutes.',
          }),

        h('div.drawer-section', { text: 'Minutes' }),
        m.minutes
          ? h('div', [
            ...global.md.render(m.minutes.body),
            h('div.crumb', { text: `RECORDED BY ${String(m.minutes.recorded_by_name || '').toUpperCase()}` }),
          ])
          : h('div', [
            h('p.note', { style: { margin: '0 0 10px' }, text: 'No minutes yet.' }),
            h('button.btn', { onclick: () => recordMinutes(app, m), text: 'RECORD MINUTES' }),
          ]),

        m.outcomes.length
          ? h('div', [
            h('div.drawer-section', { text: 'Outcomes' }),
            h('div.pill-row', m.outcomes.map((o) => h('span.pill', {
              style: {
                cursor: 'default',
                'border-color': o.kind === 'carried' ? 'var(--blocked-dim)' : 'var(--line-3)',
                color: o.kind === 'carried' ? 'var(--blocked)' : 'var(--ink-4)',
              },
              text: `${o.kind.toUpperCase()} · ${o.text}`
                + (o.owner_name ? ` · ${o.owner_name}` : '')
                + (o.wp_key ? ` · ${o.wp_key}` : '')
                + (o.carried_to_title ? ` → ${o.carried_to_title}` : ''),
            }))),
          ])
          : null,
      ]),
    ]);
  }

  function addItem(app, m) {
    const title = prompt('Agenda item:');
    if (!title) return;
    const mins = prompt('Minutes (optional):', '10');
    app.act(
      () => global.api.post(`/api/meetings/${m.id}/agenda`, {
        title, duration_min: mins ? Number(mins) : null,
      }),
      'Agenda item added'
    );
  }

  function recordMinutes(app, m) {
    const body = prompt(
      'Minutes (markdown). Recording them freezes the agenda and notifies every participant:'
    );
    if (!body) return;
    app.act(
      () => global.api.post(`/api/meetings/${m.id}/minutes`, { body, outcomes: [] }),
      'Minutes recorded'
    );
  }
}(window));
