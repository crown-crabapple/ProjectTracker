/*
 * The git deck: what the repositories are doing, and which of it is work this
 * tracker is tracking.
 *
 * The shape is gitdeck's — a repository grid with a health score, cross-repo
 * pull requests and issues, CI, a digest — with one panel gitdeck has no reason
 * to have and this app has no reason to be without: the MAPPING. Six work
 * package types, what each one means in a repository, and the example spelled
 * out, because 'F-LOAD-012 maps to pull request #978' is the whole feature and a
 * table of enum values is not.
 *
 * TWO THINGS THIS SCREEN REFUSES TO DO
 *
 *   It does not show a health score or a CI rate anywhere near a readiness
 *   percentage without saying which is which. They are different measurements of
 *   different things and the strip labels every one of them.
 *
 *   It does not paint a link a regex made and a link a person made the same.
 *   `origin` is on every row: KEY, BRANCH or MANUAL, and the key that matched is
 *   beside it. A link that cannot say why it exists is a link nobody dares
 *   delete.
 *
 * On colour: rust stays reserved for something waiting on a person — a pull that
 * errored, and an open security alert. A red CI run is late, not blocked, so it
 * is amber. See the top of app.css.
 */

(function (global) {
  'use strict';

  const { h, key, nf, meter, kpi } = global.dom;

  const KIND_LABEL = {
    pull_request: 'PULL REQUEST', issue: 'ISSUE', milestone: 'MILESTONE', release: 'RELEASE',
    workflow_run: 'CI RUN', security_alert: 'SECURITY', branch: 'BRANCH',
  };

  const STATE_COLOUR = {
    open: 'var(--ok)', draft: 'var(--ink-5)', merged: 'var(--sel)', closed: 'var(--ink-6)',
    published: 'var(--ok)', prerelease: 'var(--accent)', completed: 'var(--ink-5)',
    protected: 'var(--sel)',
  };

  global.viewDeck = async function viewDeck(app) {
    const params = { project: app.state.project };
    if (app.state.params.repo) params.repo = app.state.params.repo;
    const data = await global.api.get('/api/deck' + global.api.qs(params));
    const kind = app.state.params.kind || 'pull_request';
    const totals = totalsFor(data.repositories);

    return h('div.page', [
      h('div.page-head.baseline', [
        h('div.page-title', { text: 'Git deck' }),
        h('div.page-sub', { text: 'what the repositories are doing, and which of it is tracked work' }),
      ]),

      // Four cells because the strip is four columns wide. The two counts that
      // do not fit are in the subtitles rather than in a fifth cell that wraps.
      h('div.kpis', [
        kpi('REPOSITORIES', String(data.repositories.length),
          `${data.repositories.filter((r) => r.pullable).length} can be pulled`),
        kpi('OPEN PULL REQUESTS', String(totals.prs_open),
          `${totals.issues_open} open issue(s) · ${totals.prs_merged} merged in the mirror`),
        kpi('CI SUCCESS', totals.ci_pct === null ? '—' : `${totals.ci_pct}%`,
          totals.ci_pct === null ? 'nothing has finished yet' : 'completed runs only — this is not readiness'),
        kpi('WORK MAPPED', data.coverage.pct === null ? '—' : `${data.coverage.pct}%`,
          `${data.coverage.unlinked} work package(s) with no forge object · `
          + `${data.coverage.items_unlinked} forge item(s) with no work package`),
      ]),

      h('p.note', { text: data.note }),

      mappingPanel(app, data),

      h('div.grid.c2', [
        h('div.stack', [repositoriesPanel(app, data), pullsPanel(data)]),
        h('div.stack', [itemsPanel(app, data, kind), unmatchedPanel(data)]),
      ]),
    ]);
  };

  /** The centrepiece: the six types, and what each is in a repository. */
  function mappingPanel(app, data) {
    return h('div.panel', { style: { 'margin-bottom': '14px' } }, [
      h('div.panel-head', [
        h('h2', { text: 'How work maps to the repository' }),
        h('div.spacer'),
        h('span.panel-note', {
          text: app.state.params.repo ? 'FOR THIS REPOSITORY' : 'THE DEFAULT FOR EVERY REPOSITORY',
        }),
      ]),
      h('div.scroll-x', [h('table.responsive-table', [
        h('thead', [h('tr', [
          h('th', { text: 'Type' }), h('th', { text: 'Maps to' }), h('th', { text: 'As' }),
          h('th', { text: 'Key' }), h('th', { text: 'Example' }), h('th', { text: 'When it merges' }),
        ])]),
        h('tbody', data.mapping.map((m) => h('tr', [
          h('td', { 'data-label': 'Type' }, [key(m.type)]),
          h('td', { 'data-label': 'Maps to' }, [
            h('span.tag.small', {
              style: { color: m.item_kind === 'none' ? 'var(--ink-6)' : 'var(--sel)' },
              text: KIND_LABEL[m.item_kind] || 'NOTHING',
            }),
            m.overridden ? h('span.tag.small', { style: { color: 'var(--accent)' }, text: 'OVERRIDDEN' }) : null,
          ]),
          h('td.dim', { 'data-label': 'As', text: m.relation }),
          h('td', { 'data-label': 'Key' }, [m.key_prefix ? key(`${m.key_prefix}-…`) : h('span.dim', { text: 'WP- only' })]),
          h('td.dim', { 'data-label': 'Example', text: m.example || 'not mapped' }),
          // The sentence, not a blank. A blank cell here would read as "unknown"
          // when the fact is a decision: a pull mirrors, it does not decide.
          h('td.dim', {
            'data-label': 'When it merges',
            text: m.merged_status ? `moves to ${m.merged_status}` : 'nothing — a pull mirrors, it does not decide',
          }),
        ]))),
      ])]),
      h('div.panel-body', [
        h('p.note', {
          text: 'A work package is addressable by its own key (WP-124) and by the key its repository '
            + 'knows it as (F-LOAD-012), set per work package in the drawer. A key found in a title, a '
            + 'body or a branch name is matched against both. A key that matches nothing is kept and '
            + 'listed rather than dropped.',
        }),
      ]),
    ]);
  }

  function repositoriesPanel(app, data) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Repositories' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'HEALTH IS REPOSITORY HYGIENE, NOT READINESS' }),
      ]),
      h('div.panel-body.tight', [
        data.repositories.length
          ? h('div.rows', data.repositories.map((r) => repositoryRow(app, r)))
          : h('div.empty', { text: 'no repositories connected to the projects you can see' }),
      ]),
    ]);
  }

  function repositoryRow(app, r) {
    const healthColour = !r.health ? 'var(--ink-6)'
      : r.health.label === 'strong' ? 'var(--ok)'
        : r.health.label === 'watch' ? 'var(--accent)' : 'var(--blocked)';
    return h('div', { style: { padding: '4px 0 11px' } }, [
      h('div.row', { style: { 'flex-wrap': 'wrap' } }, [
        h('span.tag.small', { style: { 'min-width': '58px' }, text: r.scm.toUpperCase() }),
        h('div.grow', [
          h('div', { style: { 'font-size': '12.5px' }, text: r.name }),
          h('div', { style: { 'font-size': '11px', color: 'var(--ink-5)' }, text: r.slug || r.url }),
        ]),
        key(r.project_code),
        h('span.tag.small', {
          style: { color: healthColour },
          text: r.health ? `HEALTH ${r.health.score} · ${r.health.label.toUpperCase()}` : 'NOT PULLED — NO HEALTH SCORE',
        }),
      ]),
      // The digest, from gitdeck's digest view: what moved in the last day.
      // Counted, never narrated — see the header of src/domain/gitdeck.js.
      h('div', {
        style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '5px' },
        text: `LAST 24H: ${r.digest.opened} opened · ${r.digest.merged} merged · `
          + `${r.digest.closed} closed`,
      }),
      h('div', {
        style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '2px' },
        text: `${r.counts.pull_requests_open} open PR · ${r.counts.issues_open} open issue · `
          + `${r.counts.releases} release · ${r.counts.branches} branch`
          + (r.ci.success_pct === null ? ' · CI: nothing finished' : ` · CI ${r.ci.success_pct}% (${r.ci.basis})`),
      }),
      h('div', { style: { 'margin-top': '6px' } }, [
        meter(r.coverage.items_pct === null ? 0 : r.coverage.items_pct, 'var(--sel)',
          r.coverage.items_pct === null
            ? 'NOTHING TO MAP'
            : `${r.coverage.items_linked}/${r.coverage.items} FORGE OBJECTS MAPPED`,
          { thin: true }),
      ]),
      r.health ? h('div', {
        style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '4px' },
        text: `BASIS: ${r.health.basis.join(', ')}`,
      }) : null,
      r.counts.alerts_open
        ? h('div', {
          style: { 'font-size': '11px', color: 'var(--blocked)', 'margin-top': '4px' },
          text: `${r.counts.alerts_open} open security alert(s)`,
        })
        : null,
      h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center', 'margin-top': '8px', 'flex-wrap': 'wrap' } }, [
        h('span.tag.small', {
          style: {
            color: r.pull_state === 'error' ? 'var(--blocked)' : r.pull_state === 'ok' ? 'var(--ok)' : 'var(--ink-6)',
          },
          text: r.pull_state === 'never' ? 'NEVER PULLED' : `PULLED ${r.last_synced.toUpperCase()}`,
        }),
        h('span.tag.small', {
          style: {
            color: r.credential_present === false ? 'var(--blocked)'
              : r.credential_present === true ? 'var(--ok)' : 'var(--ink-6)',
          },
          text: r.credential
            ? `${r.credential} — ${r.credential_present ? 'SET' : 'NOT SET'}`
            : 'NO TOKEN — ANONYMOUS',
        }),
        h('div.spacer'),
        r.pullable ? h('button.btn.small', {
          onclick: () => runPull(app, r, true), text: 'DRY RUN',
        }) : null,
        r.pullable ? h('button.btn.small.sel', {
          onclick: () => runPull(app, r, false), text: 'PULL',
        }) : h('span.tag.small', { style: { color: 'var(--ink-6)' }, text: 'NO API CLIENT FOR THIS SCM' }),
        h('button.btn.small', {
          onclick: () => app.setParam('repo', app.state.params.repo === String(r.id) ? null : r.id),
          text: app.state.params.repo === String(r.id) ? 'ALL REPOSITORIES' : 'ONLY THIS',
        }),
      ]),
      r.pull_detail && r.pull_state === 'error'
        ? h('div', { style: { 'font-size': '11px', color: 'var(--blocked)', 'margin-top': '5px' }, text: r.pull_detail })
        : null,
    ]);
  }

  function itemsPanel(app, data, kind) {
    const items = data.items.filter((i) => i.kind === kind);
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'In the repositories' }),
        h('div.spacer'),
        h('div', { style: { display: 'flex', gap: '4px', 'flex-wrap': 'wrap' } }, data.kinds.map((k) => h('button.btn.small' + (k === kind ? '.sel' : ''), {
          onclick: () => app.setParam('kind', k),
          text: KIND_LABEL[k],
        }))),
      ]),
      h('div.panel-body.tight', [
        items.length
          ? h('div.rows', items.map((i) => itemRow(app, i)))
          : h('div.empty', {
            text: data.repositories.some((r) => r.pull_state !== 'never')
              ? `nothing of that kind in the mirror`
              : 'nothing pulled yet — press PULL on a repository',
          }),
      ]),
    ]);
  }

  function itemRow(app, item) {
    return h('div', { style: { padding: '2px 0 8px' } }, [
      h('div.row', [
        key(item.kind === 'release' || item.kind === 'branch' ? item.ref : `#${item.ref}`),
        h('div.grow', [
          item.url
            ? h('a', {
              href: item.url, target: '_blank', rel: 'noreferrer noopener',
              style: { 'font-size': '12px', color: 'var(--ink-2)' }, text: item.title || '(no title)',
            })
            : h('div', { style: { 'font-size': '12px' }, text: item.title || '(no title)' }),
          h('div', {
            style: { 'font-size': '11px', color: 'var(--ink-5)' },
            text: [
              item.repository, item.author, item.head_branch, item.labels,
              item.comment_count ? `${item.comment_count} comment(s)` : null,
            ].filter(Boolean).join(' · '),
          }),
        ]),
        h('span.tag.small', {
          style: {
            color: item.kind === 'security_alert' ? 'var(--blocked)'
              : item.conclusion === 'failure' ? 'var(--accent)'
                : STATE_COLOUR[item.state] || 'var(--ink-5)',
          },
          text: (item.conclusion || item.state || '').toUpperCase(),
        }),
        h('span.when', { text: item.when }),
      ]),
      item.links.length
        ? h('div', { style: { display: 'flex', gap: '6px', 'flex-wrap': 'wrap', 'margin-top': '5px' } },
          item.links.map((l) => h('button.btn.small', {
            onclick: () => app.openWp(l.work_package_id),
            title: `${l.relation} · matched on ${l.matched_key || 'nothing — linked by hand'} in the ${l.matched_in}`,
            text: `${l.key} · ${l.relation.toUpperCase()} · ${l.origin.toUpperCase()}`,
          })))
        : ['pull_request', 'issue', 'milestone', 'release'].includes(item.kind)
          ? h('div', {
            style: { 'font-size': '11px', color: 'var(--ink-5)', 'margin-top': '5px' },
            text: 'no work package — put its key in the title, the body or the branch, or link it from the drawer',
          })
          : null,
    ]);
  }

  function unmatchedPanel(data) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Keys that matched nothing' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'KEPT, NOT DROPPED' }),
      ]),
      h('div.panel-body.tight', [
        data.unmatched.length
          ? h('div.rows', data.unmatched.map((u) => h('div.row', [
            key(u.candidate),
            h('div.grow', [
              h('div', {
                style: { 'font-size': '11px', color: 'var(--ink-5)' },
                text: `${u.repository} · seen ${u.seen} time(s) in a ${u.matched_in}`,
              }),
            ]),
            h('span.when', { text: u.when }),
          ])))
          : h('div.empty', { text: 'every key found in the repositories resolved to a work package' }),
        h('p.note', {
          text: 'A branch named for a key this tracker has never heard of is the most useful thing a '
            + 'pull can report. Give the work package that key in its drawer and the next pull links it.',
        }),
      ]),
    ]);
  }

  function pullsPanel(data) {
    return h('div.panel', [
      h('div.panel-head', [
        h('h2', { text: 'Pulls' }),
        h('div.spacer'),
        h('span.panel-note', { text: 'RUN AS A PERSON, RECORDED AS A MACHINE' }),
      ]),
      h('div.panel-body.tight', [
        data.pulls.length
          ? h('div.rows', data.pulls.map((p) => h('div.row', [
            h('span.tag.small', {
              style: {
                'min-width': '62px',
                color: p.state === 'error' ? 'var(--blocked)' : p.state === 'dry_run' ? 'var(--ink-5)' : 'var(--ok)',
              },
              text: p.state.replace('_', ' ').toUpperCase(),
            }),
            h('div.grow', [
              h('div', { style: { 'font-size': '12px' }, text: p.repository }),
              h('div', {
                style: { 'font-size': '11px', color: 'var(--ink-5)' },
                text: `${p.items_seen} item(s), ${p.items_new} new, ${p.links_made} link(s)`
                  + (p.unmatched ? `, ${p.unmatched} unmatched` : '')
                  + ` · ${p.actor}${p.on_behalf_of ? ` on ${p.on_behalf_of}'s authority` : ''}`
                  + (p.rate_remaining !== null ? ` · ${nf(p.rate_remaining)} calls left` : '')
                  + (p.detail ? ` · ${p.detail}` : ''),
              }),
            ]),
            h('span.when', { text: p.when }),
          ])))
          : h('div.empty', { text: 'no pull has run' }),
      ]),
    ]);
  }

  function totalsFor(repositories) {
    const sum = (fn) => repositories.reduce((n, r) => n + fn(r), 0);
    const scored = sum((r) => r.ci.scored);
    const success = sum((r) => r.ci.success);
    return {
      prs_open: sum((r) => r.counts.pull_requests_open),
      prs_merged: sum((r) => r.counts.pull_requests_merged),
      issues_open: sum((r) => r.counts.issues_open),
      branches: sum((r) => r.counts.branches),
      ci_pct: scored ? Math.round((success / scored) * 100) : null,
    };
  }

  async function runPull(app, repository, dryRun) {
    const out = await app.act(
      () => global.api.post(`/api/repositories/${repository.id}/pull`, { dry_run: dryRun }),
      null
    );
    if (!out) return;
    const parts = [
      `${out.items_seen} item(s) seen`,
      `${out.items_new} new`,
      `${out.links_made} link(s)`,
      out.links_held ? `${out.links_held} held back (removed by hand)` : null,
      out.unmatched.length ? `${out.unmatched.length} key(s) matched nothing` : null,
      out.moves && out.moves.length ? `${out.moves.length} status(es) moved` : null,
      out.truncated ? 'stopped at the page limit' : null,
      out.dry_run ? 'DRY RUN — nothing was written' : null,
    ].filter(Boolean);
    app.toast(parts.join(' · '), out.problems.length ? 'bad' : 'good');
  }
}(window));
