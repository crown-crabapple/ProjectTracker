/*
 * Repositories & MCP: what this tracker is connected to, and what an assistant
 * is allowed to see.
 *
 * Two things on this page are deliberate and worth stating in the UI itself,
 * because a connections page that is vague about them is a connections page
 * nobody can audit:
 *
 *  1. NO CREDENTIAL IS EVER SHOWN, because none is stored. Each connection
 *     records the NAME of the environment variable its token is read from, so a
 *     database dump carries no secret. The page shows whether that variable is
 *     currently set, which is the useful fact.
 *
 *  2. THE MCP AUDIT COVERS READS AS WELL AS WRITES. "What did the assistant look
 *     at" is the question an audit is actually asked, and logging only writes
 *     answers a different one.
 */

(function (global) {
  'use strict';

  const { h, key, nf } = global.dom;

  const STATE_COLOURS = { connected: 'var(--ok)', off: 'var(--ink-6)', error: 'var(--blocked)' };

  global.viewConnect = async function viewConnect(app) {
    const data = await global.api.get('/api/connect');

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Repositories & MCP' }),
        h('div.page-sub', { text: 'what this tracker is connected to, and what an assistant is allowed to see' }),
      ]),

      h('div.panel', { style: { 'margin-bottom': '14px' } }, [
        h('div.panel-head', [
          h('h2', { text: 'Connections' }),
          h('div.spacer'),
          h('span.panel-note', { text: 'CREDENTIALS ARE READ FROM THE ENVIRONMENT, NEVER STORED' }),
        ]),
        h('div.scroll-x', [h('table.responsive-table', [
          h('thead', [h('tr', [
            h('th', { text: 'Connection' }), h('th', { text: 'Target' }), h('th', { text: 'State' }),
            h('th', { text: 'Detail' }), h('th', { text: 'Credential' }),
          ])]),
          h('tbody', data.integrations.map((i) => h('tr', [
            h('td', { 'data-label': 'Connection', text: i.name }),
            h('td.dim', { 'data-label': 'Target', text: i.target || 'not configured' }),
            h('td', { 'data-label': 'State' }, [
              h('span.tag.small', { style: { color: STATE_COLOURS[i.state] }, text: i.state.toUpperCase() }),
            ]),
            h('td.dim', { 'data-label': 'Detail', text: i.detail || '' }),
            h('td', { 'data-label': 'Credential' }, [
              h('span.tag.small', {
                style: {
                  color: i.credential_present === false ? 'var(--blocked)'
                    : i.credential_present === true ? 'var(--ok)' : 'var(--ink-6)',
                },
                text: i.credential_present === false ? `${i.credential} — NOT SET`
                  : i.credential_present === true ? `${i.credential} — SET` : i.credential,
              }),
            ]),
          ]))),
        ])]),
      ]),

      h('div.grid.c2', { style: { 'margin-top': '0' } }, [
        h('div.stack', [
          h('div.panel', [
            h('div.panel-head', [
              h('h2', { text: 'Repositories' }),
              h('div.spacer'),
              h('span.panel-note', { text: `${data.repositories.length} CONNECTED` }),
            ]),
            h('div.panel-body.tight', [
              data.repositories.length
                ? h('div.rows', data.repositories.map((r) => h('div.row', [
                  h('span.tag.small', { style: { 'min-width': '54px' }, text: r.scm.toUpperCase() }),
                  h('div.grow', [
                    h('div', { style: { 'font-size': '12.5px' }, text: r.name }),
                    h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)' }, text: r.url }),
                  ]),
                  key(r.project_code),
                  h('span.tag.small', {
                    style: { color: STATE_COLOURS[r.state] },
                    text: `${r.revisions} REV`,
                  }),
                  // 'connected' on a repository nothing has ever pulled is not
                  // the same fact, so both are shown.
                  h('span.tag.small', {
                    style: {
                      color: r.pull_state === 'error' ? 'var(--blocked)'
                        : r.pull_state === 'ok' ? 'var(--ok)' : 'var(--ink-6)',
                    },
                    text: r.pullable
                      ? (r.pull_state === 'never' ? 'NEVER PULLED' : `PULLED ${r.last_synced.toUpperCase()}`)
                      : 'NO API CLIENT',
                  }),
                ])))
                : h('div.empty', { text: 'no repositories connected' }),
              h('p.note', {
                text: 'A GitHub, GitLab or Forgejo repository is pulled from the git deck, the '
                  + 'command line or the git.pull MCP tool — there is no scheduler. A git or svn row '
                  + 'is recorded here and read by whoever clones it.',
              }),
              h('button.btn.small', {
                onclick: () => app.go('deck', {}),
                text: 'OPEN THE GIT DECK',
              }),
            ]),
          ]),

          h('div.panel', [
            h('div.panel-head', [h('h2', { text: 'Linked commits' })]),
            h('div.panel-body.tight', [
              data.revisions.length
                ? h('div.rows', data.revisions.map((r) => h('div.row', [
                  key(r.identifier.slice(0, 7)),
                  h('div.grow', [
                    h('div', { style: { 'font-size': '12px' }, text: r.message || '' }),
                    h('div', {
                      style: { 'font-size': '11px', color: 'var(--ink-5)' },
                      text: `${r.author || 'unknown'} · +${nf(r.insertions, '0')}/-${nf(r.deletions, '0')}`
                        + (r.work_packages ? ` · ${r.work_packages}` : ' · not linked to any work package'),
                    }),
                  ]),
                  h('span.when', { text: r.when }),
                ])))
                : h('div.empty', { text: 'no commits recorded' }),
            ]),
          ]),

          h('div.panel', [
            h('div.panel-head', [
              h('h2', { text: 'Email to task' }),
              h('div.spacer'),
              h('span.panel-note', { text: 'REJECTIONS ARE KEPT, WITH THE REASON' }),
            ]),
            h('div.panel-body.tight', [
              data.intake.length
                ? h('div.rows', data.intake.map((e) => h('div.row', [
                  h('span.tag.small', {
                    style: {
                      'min-width': '70px',
                      color: e.state === 'rejected' ? 'var(--blocked)' : e.state === 'created' ? 'var(--ok)' : 'var(--sel)',
                    },
                    text: e.state.toUpperCase(),
                  }),
                  h('div.grow', [
                    h('div', { style: { 'font-size': '12px' }, text: e.subject || '(no subject)' }),
                    h('div', {
                      style: { 'font-size': '11px', color: 'var(--ink-5)' },
                      text: e.reason || `from ${e.from_email}${e.wp_key ? ` → ${e.wp_key}` : ''}`,
                    }),
                  ]),
                  h('span.when', { text: e.when }),
                ])))
                : h('div.empty', { text: 'nothing received' }),
            ]),
          ]),
        ]),

        h('div.stack', [mcpPanel(app, data.mcp), toolsPanel(data.mcp), auditPanel(data.mcp)]),
      ]),
    ]);
  };

  function mcpPanel(app, mcp) {
    const live = mcp.tokens.filter((t) => !t.revoked);
    return h('div.panel.raised', { style: { 'border-color': 'rgba(95,184,200,.22)' } }, [
      h('div.panel-head', [
        h('span', { style: { width: '6px', height: '6px', 'border-radius': '50%', background: 'var(--sel)' } }),
        h('h2', { text: 'MCP server' }),
        h('div.spacer'),
        h('span.panel-note', {
          style: { color: live.length ? 'var(--ok)' : 'var(--ink-5)' },
          text: `${live.length} LIVE TOKEN${live.length === 1 ? '' : 'S'}`,
        }),
      ]),
      h('div.panel-body', [
        h('dl.wiki-meta', { style: { 'grid-template-columns': '92px 1fr' } }, [
          h('dt', { text: 'TRANSPORT' }), h('dd', { text: mcp.transport }),
          h('dt', { text: 'COMMAND' }), h('dd', [h('code', { text: mcp.command })]),
          h('dt', { text: 'SCOPE' }), h('dd', { text: 'internal comments are excluded from every read, at any scope' }),
          h('dt', { text: 'AUDIT' }), h('dd', { text: `${mcp.auditCount} call(s) recorded — reads included` }),
        ]),
        live.length
          ? h('div.rows', { style: { 'margin-top': '14px' } }, live.map((t) => h('div.row', [
            h('div.grow', [
              h('div', { style: { 'font-size': '12px' }, text: t.name }),
              h('div', {
                style: { 'font-size': '11px', color: 'var(--ink-5)' },
                text: `${t.hint} · ${t.scope} scope · `
                  + (t.project_scope ? `${t.project_scope.length} project(s)` : 'every project')
                  + ` · last used ${t.last_used}`,
              }),
            ]),
            h('button.btn.small.danger', {
              onclick: () => revoke(app, t),
              text: 'REVOKE',
            }),
          ])))
          : h('p.note', { style: { margin: '14px 0 0' }, text: 'No live tokens. An assistant cannot read anything.' }),
        h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '14px' } }, [
          h('button.btn.sel', { onclick: () => issue(app, 'read'), text: 'ISSUE A READ TOKEN' }),
          h('button.btn', { onclick: () => issue(app, 'write'), text: 'ISSUE A WRITE TOKEN' }),
        ]),
      ]),
    ]);
  }

  function toolsPanel(mcp) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Tools exposed' }),
        h('div.spacer'),
        // Two counts, not one total. Adding done and in build together and
        // calling the sum "implemented" is the arithmetic this whole tracker
        // exists to avoid making.
        h('span.panel-note', {
          text: `${mcp.tools.filter((t) => t.status === 'done').length} DONE · `
            + `${mcp.tools.filter((t) => t.status === 'in_build').length} IN BUILD`,
        }),
      ]),
      h('div.panel-body.tight', [
        h('div.rows', mcp.tools.map((t) => h('div', { style: { padding: '9px 0' } }, [
          h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '8px' } }, [
            h('code', { style: { 'font-size': '11.5px', color: 'var(--ink-2)' }, text: t.name }),
            h('span.tag.small', {
              style: { color: t.mode === 'write' ? 'var(--blocked)' : 'var(--ink-5)' },
              text: t.mode.toUpperCase(),
            }),
            h('div.spacer'),
            h('span.tag.small', {
              style: {
                color: t.status === 'done' ? 'var(--ok)' : t.status === 'in_build' ? 'var(--accent)'
                  : t.status === 'speccing' ? 'var(--sel)' : 'var(--ink-6)',
              },
              text: t.status.replace('_', ' ').toUpperCase(),
            }),
          ]),
          h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '2px' }, text: t.detail || '' }),
        ]))),
        h('p.note', {
          text: `${mcp.tools.filter((t) => t.mode === 'write').length} of these write, and a read-scoped `
            + 'token is not offered them at all. A write runs with the permissions of the person who '
            + 'issued the token and can do no more than they can, and the activity trail records it as '
            + 'this server rather than as them. Every call — read or write — lands in the audit below.',
        }),
      ]),
    ]);
  }

  function auditPanel(mcp) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'MCP audit' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'READS AND WRITES' }),
      ]),
      h('div.panel-body.tight', [
        mcp.audit.length
          ? h('div.rows', mcp.audit.map((a) => h('div.row', [
            h('span.tag.small', {
              style: {
                'min-width': '54px',
                color: a.outcome === 'ok' ? 'var(--ok)' : a.outcome === 'denied' ? 'var(--blocked)' : 'var(--accent)',
              },
              text: a.outcome.toUpperCase(),
            }),
            h('div.grow', [
              h('code', { style: { 'font-size': '11.5px' }, text: a.tool }),
              h('div', {
                style: { 'font-size': '11px', color: 'var(--ink-5)' },
                text: `${a.mode} · ${a.token_hint || 'no token'}`
                  + (a.row_count !== null && a.row_count !== undefined ? ` · ${a.row_count} row(s)` : '')
                  + (a.duration_ms ? ` · ${a.duration_ms}ms` : '')
                  + (a.result_note ? ` · ${a.result_note}` : ''),
              }),
            ]),
            h('span.when', { text: a.when }),
          ])))
          : h('div.empty', { text: 'no MCP calls yet' }),
      ]),
    ]);
  }

  async function issue(app, scope) {
    const name = prompt(`Name this ${scope} token (it appears in the audit):`, `assistant · ${scope}`);
    if (!name) return;
    const out = await app.act(
      () => global.api.post('/api/admin/mcp-tokens', { name, scope }),
      null
    );
    if (!out) return;
    // Shown once. Not recoverable — the database holds only the hash.
    const shown = prompt(
      'This is the only time the token is shown. It is not recoverable — the database stores only its '
      + 'hash. Copy it now:',
      out.secret
    );
    void shown;
  }

  function revoke(app, token) {
    if (!confirm(`Revoke "${token.name}"? Any assistant using it stops working immediately.`)) return;
    app.act(() => global.api.del(`/api/admin/mcp-tokens/${token.id}`), 'Token revoked');
  }
}(window));
