/*
 * Administration.
 *
 * Six tabs. The one that matters most is STATUSES & WORKFLOW, because the
 * progress weights on that screen are the entire progress model — every
 * percentage anywhere in the product is derived from them. The screen says so,
 * and it distinguishes a weight of 0 from EXCLUDED FROM THE DENOMINATOR in
 * words, because in a table those two look similar and mean opposite things.
 */

(function (global) {
  'use strict';

  const { h, key, nf } = global.dom;

  const TABS = [
    ['fields', 'CUSTOM FIELDS'],
    ['workflow', 'STATUSES & WORKFLOW'],
    ['auto', 'CUSTOM ACTIONS'],
    ['roles', 'ROLES & GROUPS'],
    ['theme', 'THEME & FORMS'],
    ['initiation', 'PROJECT INITIATION'],
  ];

  global.viewAdmin = async function viewAdmin(app) {
    const tab = app.state.params.tab || 'fields';
    const data = await global.api.get(`/api/admin${global.api.qs({ tab })}`);

    return h('div.page', [
      h('div.page-head', [
        h('div.page-title', { text: 'Administration' }),
        h('div.spacer'),
        h('div.pill-row', TABS.map(([id, label]) => h('button.pill' + (tab === id ? '.is-on' : ''), {
          onclick: () => app.setParam('tab', id),
          text: label,
        }))),
      ]),
      (PANELS[tab] || PANELS.fields)(app, data),
    ]);
  };

  const PANELS = {
    fields: (app, data) => h('div', [
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Custom fields' }),
          h('div.spacer'),
          h('button.btn.small', { onclick: () => newField(app), text: '+ FIELD' }),
        ]),
        h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'Field' }), h('th', { text: 'Type' }), h('th', { text: 'On' }),
            h('th', { text: 'Projects' }), h('th', { text: 'Help text' }),
            h('th.r', { text: 'Used' }), h('th', { text: 'Required' }),
          ])]),
          h('tbody', (data.fields || []).map((f) => h('tr', [
            h('td', { 'data-label': 'Field', text: f.name }),
            h('td', { 'data-label': 'Type' }, [
              h('span.tag.small', { text: f.format.toUpperCase() }),
              f.values ? h('div', { style: { 'font-size': '10.5px', color: 'var(--ink-6)' }, text: f.values.join(', ') }) : null,
            ]),
            h('td.dim', { 'data-label': 'On', text: f.entity.replace('_', ' ') }),
            h('td.dim', { 'data-label': 'Projects', text: f.scope }),
            h('td.dim', { 'data-label': 'Help text', style: { 'max-width': '280px' }, text: f.help || '—' }),
            h('td.r', { 'data-label': 'Used' }, [h('span.tag.small', { text: String(f.used) })]),
            h('td', { 'data-label': 'Required' }, [
              h('span.tag.small', {
                style: { color: f.required ? 'var(--accent)' : 'var(--ink-6)' },
                text: f.required ? 'REQUIRED' : 'OPTIONAL',
              }),
            ]),
          ]))),
        ])]),
      ]),
      h('p.note', {
        text: 'Help text appears as a hint next to the attribute wherever it is shown, which is the only '
          + 'documentation most fields need. There is no cap on the number of custom fields; there is a '
          + 'cap on how many appear on a form before it needs a section.',
      }),
      (data.helpTexts || []).length
        ? h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'Attribute help texts' })]),
          h('div.panel-body.tight', [
            h('div.rows', data.helpTexts.map((t) => h('div.row', [
              h('span.tag.small', { style: { 'min-width': '110px' }, text: `${t.entity}.${t.attribute}` }),
              h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-4)' }, text: t.help }),
            ]))),
          ]),
        ])
        : null,
    ]),

    workflow: (app, data) => h('div', [
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Statuses & workflow' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'THESE WEIGHTS ARE THE PROGRESS MODEL' }),
        ]),
        h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'Status' }), h('th', { text: 'Counts as' }),
            h('th', { text: 'Progress weight' }), h('th.r', { text: 'In use' }),
            h('th', { text: 'Allowed transitions' }),
          ])]),
          h('tbody', (data.statuses || []).map((s) => h('tr', [
            h('td', { 'data-label': 'Status' }, [
              h('span.tag', { style: { color: s.colour }, text: s.label }),
            ]),
            h('td', { 'data-label': 'Counts as' }, [
              h('span.tag.small', {
                style: { color: s.closed ? 'var(--ok)' : 'var(--ink-5)' },
                text: s.closed ? 'CLOSED' : 'OPEN',
              }),
            ]),
            h('td', { 'data-label': 'Weight' }, [
              h('button.pill', {
                style: s.weight === null ? { color: 'var(--sel)', 'border-color': 'var(--sel-dim)' } : null,
                onclick: () => setWeight(app, s),
                title: 'Change this and every percentage in the portfolio changes',
                text: s.weightLabel,
              }),
            ]),
            h('td.r', { 'data-label': 'In use' }, [h('span.tag.small', { text: String(s.inUse) })]),
            h('td.dim', { 'data-label': 'Transitions', text: s.allowed }),
          ]))),
        ])]),
      ]),
      h('p.note', {
        text: 'Weights are the whole progress model: speccing 0.35, in build 0.7, done 1. Deferred and '
          + 'rejected are EXCLUDED FROM THE DENOMINATOR rather than scored zero — that difference is what '
          + 'stops a project from looking better because work was pushed out of it, and it is why the '
          + 'column says the word rather than showing a blank.',
      }),
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Work package types' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'A SUBJECT PATTERN GENERATES A BLANK SUBJECT, NEVER OVERWRITES ONE' }),
        ]),
        h('div.panel-body.tight', [
          h('div.rows', (data.types || []).map((t) => h('div.row', [
            h('span.tag', { style: { color: t.colour, 'min-width': '90px' }, text: t.name }),
            h('span.grow', {
              style: { 'font-size': '11.5px', color: t.subject_pattern ? 'var(--ink-3)' : 'var(--ink-6)' },
              text: t.subject_pattern || 'subject always typed by hand',
            }),
            t.is_milestone ? h('span.tag.small', { style: { color: 'var(--sel)' }, text: 'ONE DATE' }) : null,
          ]))),
        ]),
      ]),
    ]),

    auto: (app, data) => h('div', [
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Custom actions' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'THEY WRITE TO THE ACTIVITY FEED LIKE A PERSON WOULD' }),
        ]),
        h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'When' }), h('th', { text: 'Do' }), h('th', { text: 'Projects' }),
            h('th.r', { text: 'Applied' }), h('th', { text: 'Last run' }), h('th', { text: 'State' }),
          ])]),
          h('tbody', (data.automations || []).map((a) => h('tr', [
            h('td', { 'data-label': 'When' }, [
              h('div', { text: a.name }),
              h('div', { style: { 'font-size': '10.5px', color: 'var(--ink-6)' }, text: a.trigger.replace(/_/g, ' ') }),
            ]),
            h('td.dim', { 'data-label': 'Do', text: a.action.replace(/_/g, ' ') }),
            h('td.dim', { 'data-label': 'Projects', text: a.scope }),
            h('td.r', { 'data-label': 'Applied' }, [
              h('span.tag.small', { text: `${a.applied}/${a.runs}` }),
              a.failed ? h('div.tag.small', { style: { color: 'var(--blocked)' }, text: `${a.failed} FAILED` }) : null,
            ]),
            h('td.dim', { 'data-label': 'Last run', text: a.last_run }),
            h('td', { 'data-label': 'State' }, [
              h('button.pill' + (a.enabled ? '.is-on' : ''), {
                onclick: () => toggle(app, a),
                text: a.enabled ? 'ON' : 'OFF',
              }),
              a.note
                ? h('div', {
                  style: { 'font-size': '10.5px', color: 'var(--ink-5)', 'max-width': '260px', 'margin-top': '4px' },
                  text: a.note,
                })
                : null,
            ]),
          ]))),
        ])]),
      ]),
      h('p.note', {
        text: 'Custom actions run on the server and write to the activity feed tagged with the '
          + 'automation as the actor, so an automated change is never indistinguishable from a human one. '
          + 'Turning one off requires a note: without it, somebody turns it back on in six months and '
          + 'rediscovers why it was off.',
      }),
      (data.runs || []).length
        ? h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'Recent runs' })]),
          h('div.panel-body.tight', [
            h('div.rows', data.runs.map((r) => h('div.row', [
              h('span.tag.small', {
                style: {
                  'min-width': '56px',
                  color: r.outcome === 'applied' ? 'var(--ok)' : r.outcome === 'failed' ? 'var(--blocked)' : 'var(--ink-6)',
                },
                text: r.outcome.toUpperCase(),
              }),
              h('span', { style: { 'font-size': '11.5px', 'min-width': '200px' }, text: r.name }),
              h('span.grow', { style: { 'font-size': '11px', color: 'var(--ink-5)' }, text: r.detail || '' }),
              r.wp_key ? key(r.wp_key) : null,
              h('span.when', { text: r.when }),
            ]))),
          ]),
        ])
        : null,
    ]),

    roles: (app, data) => h('div.grid.c2', { style: { 'margin-top': '0' } }, [
      h('div.stack', [
        h('div.panel', [
          h('div.panel-head', [
            h('h2', { text: 'Roles' }),
            h('div.spacer'),
            h('span.panel-note', { text: `${(data.permissions || []).length} PERMISSIONS DEFINED` }),
          ]),
          h('div.panel-body.tight', [
            h('div.rows', (data.roles || []).map((r) => h('div', { style: { padding: '9px 0' } }, [
              h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
                h('span', {
                  style: { 'font-size': '12.5px', color: r.name === 'Placeholder' ? 'var(--ink-6)' : 'var(--ink-2)' },
                  text: r.name,
                }),
                h('div.spacer'),
                h('span.tag.small', { text: `${r.permissions} PERMISSIONS · ${r.grants} GRANT(S)` }),
              ]),
              h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)' }, text: r.description || '' }),
            ]))),
            h('p.note', {
              text: 'Permissions resolve as the UNION of every role a person holds directly and through a '
                + 'group. Taking the intersection would mean adding somebody to a group could quietly '
                + 'reduce their access.',
            }),
          ]),
        ]),
        h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'Groups' })]),
          h('div.panel-body.tight', [
            h('div.rows', (data.groups || []).map((g) => h('div.row', [
              h('span.grow', { style: { 'font-size': '12.5px' }, text: g.name }),
              h('span.tag.small', {
                text: `${g.members} MEMBER(S)${g.projects ? ' · ' + g.projects : ''}`,
              }),
            ]))),
          ]),
        ]),
      ]),
      h('div.stack', [
        h('div.panel', [
          h('div.panel-head', [
            h('h2', { text: 'Placeholder users' }),
            h('div.spacer'),
            h('span.panel-note', { text: 'ASSIGNABLE · CANNOT SIGN IN' }),
          ]),
          h('div.panel-body.tight', [
            (data.placeholders || []).length
              ? h('div.rows', data.placeholders.map((p) => h('div.row', [
                h('div.grow', [
                  h('div', { style: { 'font-size': '12.5px', color: 'var(--ink-3)' }, text: p.name }),
                  p.placeholder_for
                    ? h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)' }, text: `will become: ${p.placeholder_for}` })
                    : null,
                ]),
                h('span.tag.small', {
                  text: `${p.assignments} ASSIGNMENT(S) · ${nf(p.booked, '0')} H BOOKED`,
                }),
              ])))
              : h('div.empty', { text: 'no placeholder users' }),
            h('p.note', {
              text: 'A placeholder holds work before a person exists. Converting one to a real account '
                + 'keeps every assignment and comment attached, which is why it is a kind of user rather '
                + 'than a flag on a work package.',
            }),
          ]),
        ]),
        h('div.panel', [
          h('div.panel-head', [h('h2', { text: 'People' })]),
          h('div.scroll-x', [h('table.responsive-table', [
            h('thead', [h('tr', [
              h('th', { text: 'Name' }), h('th', { text: 'Login' }), h('th', { text: 'Kind' }),
              h('th.r', { text: 'Projects' }), h('th.r', { text: 'Capacity' }),
            ])]),
            h('tbody', (data.people || []).map((u) => h('tr', [
              h('td', { 'data-label': 'Name', text: u.name }),
              h('td.dim', { 'data-label': 'Login', text: u.login || '—' }),
              h('td', { 'data-label': 'Kind' }, [
                h('span.tag.small', {
                  style: { color: u.kind === 'user' ? 'var(--ink-4)' : 'var(--ink-6)' },
                  text: u.is_admin ? 'ADMIN' : u.kind.toUpperCase(),
                }),
              ]),
              h('td.r', { 'data-label': 'Projects', text: String(u.projects) }),
              h('td.r', { 'data-label': 'Capacity', text: u.weekly_capacity ? `${nf(u.weekly_capacity)} h` : '—' }),
            ]))),
          ])]),
        ]),
      ]),
    ]),

    theme: (app, data) => h('div.grid.c2', { style: { 'margin-top': '0' } }, [
      h('div.panel', [
        h('div.panel-head', [h('h2', { text: 'Theme' })]),
        h('div.panel-body', [
          ...(data.themes || []).map((t) => h('div', { style: { 'margin-bottom': '18px' } }, [
            h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px', 'margin-bottom': '10px' } }, [
              h('span', { style: { 'font-size': '12.5px' }, text: t.name }),
              t.is_default ? h('span.tag.small', { style: { color: 'var(--ok)' }, text: 'DEFAULT' }) : null,
            ]),
            h('div', { style: { display: 'flex', gap: '6px', 'margin-bottom': '12px' } },
              ['--accent', '--ok', '--blocked', '--sel'].map((token) => h('div', {
                style: {
                  width: '40px', height: '26px', 'border-radius': '4px',
                  background: t.tokens[token] || 'transparent',
                  border: '1px solid var(--line-3)',
                },
                title: `${token}: ${t.tokens[token]}`,
              }))),
            h('dl.wiki-meta', { style: { 'grid-template-columns': '86px 1fr' } }, [
              h('dt', { text: 'IN BUILD' }), h('dd', { text: 'amber — also the primary metric colour' }),
              h('dt', { text: 'DONE' }), h('dd', { text: 'green — pass, closed, gate met' }),
              h('dt', { text: 'BLOCKED' }), h('dd', { text: 'rust — reserved for things needing a decision' }),
              h('dt', { text: 'SELECTION' }), h('dd', { text: 'cyan — selection, plan, generated content' }),
              h('dt', { text: 'TYPE' }), h('dd', { text: 'a prose face for prose, a label face for every label and numeral' }),
            ]),
            t.reserved_note ? h('p.note', { text: t.reserved_note }) : null,
          ])),
        ]),
      ]),
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Form configuration' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'PER WORK PACKAGE TYPE' }),
        ]),
        h('div.panel-body.tight', [
          ...(data.forms || []).map((f) => h('div', { style: { padding: '11px 0', 'border-bottom': '1px solid var(--line-2)' } }, [
            h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px', 'margin-bottom': '7px' } }, [
              h('span.tag', { text: f.type_name }),
              h('div.spacer'),
              h('span.tag.small', { text: `${f.sections.length} SECTION(S)` }),
            ]),
            ...f.sections.map((s) => h('div', {
              style: { 'font-size': '11.5px', color: 'var(--ink-4)', padding: '2px 0 2px 12px' },
              text: `≡ ${s.name} — ${s.fields.map((x) => x.attribute).join(', ')}`,
            })),
          ])),
          h('p.note', {
            text: 'Sections are per work package type. The MILESTONE form drops the estimates section '
              + 'entirely, which is why a milestone cannot accidentally carry hours — the field is not on '
              + 'the form rather than being validated away afterwards.',
          }),
        ]),
      ]),
    ]),

    initiation: (app, data) => h('div', [
      h('div.panel', [
        h('div.panel-head', [
          h('h2', { text: 'Project initiation requests' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'A PROJECT WITH NO REQUEST WAS CREATED DIRECTLY, AND THAT IS VISIBLE' }),
        ]),
        h('div.panel-body.tight', [
          (data.requests || []).length
            ? h('div.rows', data.requests.map((r) => h('div', { style: { padding: '12px 0' } }, [
              h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
                h('span', { style: { 'font-size': '13px' }, text: r.name }),
                h('span.tag.small', {
                  style: {
                    color: r.state === 'created' ? 'var(--ok)' : r.state === 'rejected' ? 'var(--blocked)' : 'var(--accent)',
                  },
                  text: r.state.toUpperCase(),
                }),
                h('div.spacer'),
                h('span.tag.small', {
                  text: `${(r.template_code || 'no template')} · requested by ${r.requested_by_name}`,
                }),
              ]),
              h('dl.wiki-meta', { style: { 'margin-top': '8px', 'grid-template-columns': '86px 1fr' } },
                Object.entries(r.answers || {}).flatMap(([k, v]) => [
                  h('dt', { text: k.toUpperCase() }), h('dd', { text: String(v) }),
                ])),
              r.state === 'submitted'
                ? h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '10px' } }, [
                  h('button.btn.primary.small', { onclick: () => decide(app, r, true), text: 'APPROVE & CREATE' }),
                  h('button.btn.small.danger', { onclick: () => decide(app, r, false), text: 'REJECT' }),
                ])
                : h('div', {
                  style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '6px' },
                  text: `${r.state} by ${r.decided_by_name || 'unknown'}`
                    + (r.created_code ? ` → ${r.created_code}` : '')
                    + (r.decision_note ? ` · ${r.decision_note}` : ''),
                }),
            ])))
            : h('div.empty', { text: 'no requests' }),
        ]),
      ]),
      h('p.note', {
        text: 'Approving a request creates the project from its template in one transaction — phases, '
          + 'versions, the wiki skeleton, boards and the Owner membership. A project half-created from a '
          + 'template is worse than none, because the missing half is invisible.',
      }),
    ]),
  };

  // ------------------------------------------------------------------- actions

  function setWeight(app, status) {
    const answer = prompt(
      `${status.label}\n\n`
      + 'The progress weight. Every percentage in the portfolio is derived from these.\n\n'
      + 'A number between 0 and 1, or the word "excluded" to leave the denominator entirely — '
      + 'which is NOT the same as 0.',
      status.weight === null ? 'excluded' : String(status.weight)
    );
    if (answer === null) return;
    const value = /^excluded$/i.test(answer.trim()) ? null : Number(answer);
    app.act(
      () => global.api.patch(`/api/admin/statuses/${status.id}`, { weight: value }),
      'Weight changed — every percentage in the portfolio has moved'
    );
  }

  function toggle(app, automation) {
    if (automation.enabled) {
      const note = prompt(
        `Turning off "${automation.name}".\n\n`
        + 'Say why. The note is what stops it being turned back on blind in six months:'
      );
      if (!note) return;
      app.act(() => global.api.patch(`/api/admin/automations/${automation.id}`, { enabled: false, note }), 'Turned off');
      return;
    }
    app.act(() => global.api.patch(`/api/admin/automations/${automation.id}`, { enabled: true }), 'Turned on');
  }

  function newField(app) {
    const name = prompt('Field name:');
    if (!name) return;
    const format = prompt('Format — text, long_text, int, decimal, date, bool, list, user, version:', 'text');
    if (!format) return;
    let values = null;
    if (format === 'list') {
      const raw = prompt('Possible values, comma separated:');
      if (!raw) return;
      values = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const help = prompt('Help text — it appears as a hint wherever the attribute is shown:') || null;
    app.act(
      () => global.api.post('/api/admin/custom-fields', {
        name, field_format: format, possible_values: values, help_text: help,
      }),
      'Field added'
    );
  }

  function decide(app, request, approve) {
    if (!approve) {
      const note = prompt('Reject — say why:');
      if (!note) return;
      app.act(() => global.api.post(`/api/admin/initiation/${request.id}`, { approve: false, note }), 'Rejected');
      return;
    }
    const code = prompt('Short code for the new project:', request.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase());
    if (!code) return;
    app.act(
      () => global.api.post(`/api/admin/initiation/${request.id}`, { approve: true, code }),
      'Approved and created'
    );
  }
}(window));
