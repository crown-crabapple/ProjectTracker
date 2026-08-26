/*
 * Activity & inbox.
 *
 * Two panels because they answer two questions. The inbox is what one person
 * needs to be told and carries read state; the feed is what happened to the
 * projects and carries none. Marking something read must never be able to erase
 * the fact that it happened, which is why they are separate tables and separate
 * panels rather than one list with a flag.
 */

(function (global) {
  'use strict';

  const { h, key } = global.dom;

  const KIND_COLOURS = {
    mention: 'var(--accent)', date_alert: 'var(--blocked)', assigned: 'var(--ok)',
    watching: 'var(--sel)', internal: 'var(--ink-4)', shared: 'var(--accent)',
    gate: 'var(--ok)', comment: 'var(--ink-5)', automation: 'var(--sel)',
    ai: 'var(--sel)', repo: 'var(--ok)', wiki: 'var(--ink-5)', file: 'var(--ink-5)',
    status: 'var(--ink-5)', sprint: 'var(--accent)', baseline: 'var(--accent)',
    share: 'var(--accent)', meeting: 'var(--sel)', project: 'var(--accent)',
    member: 'var(--ink-5)', version: 'var(--ink-5)',
  };
  const colour = (kind) => KIND_COLOURS[kind] || 'var(--ink-5)';

  global.viewActivity = async function viewActivity(app) {
    const data = await global.api.get('/api/activity');

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Activity & inbox' }),
        h('div.page-sub', { text: 'the inbox is yours and carries read state; the feed is the audit trail and carries none' }),
      ]),

      h('div.grid.c2-narrow', { style: { 'margin-top': '0' } }, [
        h('div.panel', [
          h('div.panel-head', [
            h('h2', { text: 'Inbox' }),
            h('div.spacer'),
            h('span.panel-note', { text: `${data.unread} UNREAD` }),
            data.unread
              ? h('button.btn.small', {
                onclick: () => app.act(
                  () => global.api.post('/api/notifications/read', { all: true }),
                  'Inbox marked read'
                ),
                text: 'MARK ALL READ',
              })
              : null,
          ]),
          h('div.panel-body.tight', [
            data.inbox.length
              ? h('div.rows', data.inbox.map((n) => h('div.row' + (n.work_package_id ? '.clickable' : ''), {
                style: { padding: '11px 0', 'align-items': 'flex-start' },
                onclick: () => {
                  if (n.unread) global.api.post('/api/notifications/read', { ids: [n.id] }).catch(() => {});
                  if (n.work_package_id) app.openWp(n.work_package_id);
                },
              }, [
                h('span', {
                  style: {
                    width: '2px', height: '26px', 'border-radius': '1px', 'flex-shrink': '0',
                    background: colour(n.kind), opacity: n.unread ? '1' : '.35',
                  },
                }),
                h('div.grow', [
                  h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
                    h('span.tag.small', { style: { color: colour(n.kind) }, text: n.kind.replace('_', ' ').toUpperCase() }),
                    h('div.spacer'),
                    h('span.when', { text: n.when }),
                  ]),
                  h('div', {
                    style: { 'font-size': '12px', color: n.unread ? 'var(--ink-2)' : 'var(--ink-5)', 'margin-top': '2px' },
                    text: n.title,
                  }),
                  n.detail
                    ? h('div', {
                      style: { 'font-size': '11px', color: 'var(--ink-4)', 'line-height': '1.55' },
                      text: n.detail,
                    })
                    : null,
                ]),
              ])))
              : h('div.empty', { text: 'nothing in the inbox' }),
          ]),
        ]),

        h('div.panel', [
          h('div.panel-head', [
            h('h2', { text: 'Activity · all projects' }),
            h('div.spacer'),
            h('span.panel-note', { text: 'NEVER DELETED, NEVER CAPPED' }),
          ]),
          h('div.panel-body.tight', [
            data.feed.length
              ? h('div.rows', data.feed.map((a) => h('div.row' + (a.work_package_id ? '.clickable' : ''), {
                style: { padding: '11px 0', 'align-items': 'flex-start' },
                onclick: () => a.work_package_id && app.openWp(a.work_package_id),
              }, [
                h('span', {
                  style: {
                    width: '2px', height: '26px', 'border-radius': '1px', 'flex-shrink': '0',
                    background: colour(a.kind),
                  },
                }),
                h('div.grow', [
                  h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px', 'flex-wrap': 'wrap' } }, [
                    h('span', { style: { 'font-size': '12px', color: 'var(--ink-2)' } }, [
                      // A machine actor is drawn in cyan and never as a person.
                      // An automated change indistinguishable from a human one
                      // is a change nobody can explain a week later.
                      h('b', {
                        style: { 'font-weight': '600', color: a.is_machine ? 'var(--sel)' : 'var(--ink)' },
                        text: a.who,
                      }),
                      ` ${a.verb}`,
                    ]),
                    a.target ? key(a.target) : null,
                    a.from && a.to
                      ? h('span.tag.small', { text: `${a.from} → ${a.to}` })
                      : null,
                    h('div.spacer'),
                    h('span.when', { text: a.when }),
                  ]),
                  a.detail
                    ? h('div', {
                      style: {
                        'font-size': '11.5px', color: 'var(--ink-4)', 'line-height': '1.6',
                        'margin-top': '2px', 'text-wrap': 'pretty',
                      },
                      text: a.detail,
                    })
                    : null,
                ]),
              ])))
              : h('div.empty', { text: 'no activity recorded' }),
          ]),
        ]),
      ]),
    ]);
  };

  global.activityColour = colour;
}(window));
