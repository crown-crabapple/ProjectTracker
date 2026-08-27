/*
 * The work package drawer.
 *
 * The one place where every attribute of one work package is on screen at once,
 * and the only editor for most of them. Three things here are worth stating:
 *
 *  1. THE PROGRESS BAR SAYS WHICH BASIS IT IS USING. Booked-against-estimate
 *     where there is an estimate, status weight where there is not. A bar that
 *     silently switched basis would be a bar nobody could read.
 *
 *  2. AN INTERNAL COMMENT IS DRAWN DIFFERENTLY AND LABELLED. The filtering
 *     happens on the server, so a reader without the permission never receives
 *     one; this is about the author knowing what they are about to write.
 *
 *  3. A SHARE LINK SAYS WHAT IT EXCLUDES. Internal comments are never in a
 *     share, at any permission, and the panel says so where the link is created
 *     rather than in a help page.
 */

(function (global) {
  'use strict';

  const { h, fill, key, tag, nf, pct, avatar } = global.dom;

  let currentId = null;

  async function open(app, id) {
    const drawer = document.getElementById('drawer');
    const scrim = document.getElementById('scrim');
    scrim.hidden = false;
    drawer.hidden = false;
    if (currentId !== id) fill(drawer, h('div.drawer-body', h('div.empty', { text: 'loading' })));
    currentId = id;

    let data;
    try {
      // Two requests, in parallel, rather than one payload. The repository panel
      // reads a different set of tables and a different permission, and folding
      // it into the drawer's own endpoint would make every drawer open wait on
      // the git mirror to answer.
      const [wp, git] = await Promise.all([
        global.api.get(`/api/wp/${id}`, { key: 'drawer' }),
        global.api.get(`/api/wp/${id}/git`, { key: 'drawer-git' }).catch(() => null),
      ]);
      data = wp;
      data.git = git;
    } catch (e) {
      if (e.superseded) return;
      fill(drawer, h('div.drawer-body', [
        h('p', { text: e.message }),
        h('button.btn', { onclick: () => app.closeWp(), text: 'CLOSE' }),
      ]));
      return;
    }
    if (currentId !== id) return;
    fill(drawer, render(app, data));
    drawer.querySelector('.drawer-head button').focus();
  }

  function close() {
    document.getElementById('drawer').hidden = true;
    document.getElementById('scrim').hidden = true;
    currentId = null;
  }

  function render(app, d) {
    const w = d.wp;
    return [
      h('div.drawer-head', [
        h('div.top', [
          key(w.key),
          h('span.type-tag', { style: { color: w.type_colour, margin: '0' }, text: w.type }),
          tag(w.status_label, w.status_colour),
          h('div.spacer'),
          h('button.btn.small', { onclick: () => app.closeWp(), text: 'CLOSE' }),
        ]),
        h('h2', { text: w.subject }),
        h('div.crumbs', { text: d.breadcrumb.join('  ›  ').toUpperCase() }),
      ]),

      h('div.drawer-body', [
        fields(app, d),
        progress(d),
        editControls(app, d),
        relations(app, d),
        repository(app, d),
        customValues(d),
        files(app, d),
        shares(app, d),
        comments(app, d),
      ]),
    ];
  }

  function fields(app, d) {
    const w = d.wp;
    return h('dl.field-grid', [
      h('dt', { text: 'ASSIGNEE' }),
      h('dd', {
        style: { color: w.assignee ? (w.assignee_kind === 'placeholder' ? 'var(--ink-6)' : 'var(--ink-3)') : 'var(--ink-6)' },
        text: w.assignee ? w.assignee + (w.assignee_kind === 'placeholder' ? ' (placeholder)' : '') : 'nobody',
      }),
      h('dt', { text: 'ACCOUNTABLE' }), h('dd', { text: w.accountable || 'nobody' }),
      h('dt', { text: 'WATCHERS' }),
      h('dd', [
        d.watchers.length
          ? h('div', { style: { display: 'flex', gap: '5px', 'align-items': 'center', 'flex-wrap': 'wrap' } }, [
            ...d.watchers.map((u) => avatar(u)),
            h('button.btn.small', {
              onclick: () => app.act(
                () => global.api.post(`/api/wp/${w.id}/watch`, { on: !watching(app, d) }),
                watching(app, d) ? 'No longer watching' : 'Watching'
              ),
              text: watching(app, d) ? 'UNWATCH' : 'WATCH',
            }),
          ])
          : h('button.btn.small', {
            onclick: () => app.act(() => global.api.post(`/api/wp/${w.id}/watch`, { on: true }), 'Watching'),
            text: 'WATCH THIS',
          }),
      ]),
      h('dt', { text: 'PRIORITY' }), h('dd', [tag(w.priority_label, w.priority_colour)]),
      h('dt', { text: 'DATES' }),
      h('dd', {
        style: { color: w.overdue ? 'var(--blocked)' : 'var(--ink-3)' },
        text: w.dates + (d.baseline && d.baseline.slip
          ? `  (baseline slipped ${d.baseline.slip} day${d.baseline.slip === 1 ? '' : 's'})`
          : ''),
      }),
      h('dt', { text: 'SCHEDULING' }), h('dd', { style: { color: 'var(--ink-4)' }, text: d.scheduling.explanation }),
      h('dt', { text: 'VERSION' }), h('dd', { text: w.version || '—' }),
      h('dt', { text: 'SPRINT' }),
      h('dd', {
        style: { color: w.sprint_shared ? 'var(--sel)' : 'var(--ink-3)' },
        text: w.sprint ? w.sprint + (w.sprint_shared ? ' (shared across projects)' : '') : 'backlog',
      }),
      h('dt', { text: 'POINTS' }),
      h('dd', { text: w.story_points === null ? 'not estimated' : String(w.story_points) }),
      h('dt', { text: 'ESTIMATE' }),
      h('dd', { text: w.estimated_hours ? `${nf(w.estimated_hours)} h` : 'no estimate' }),
    ]);
  }

  const watching = (app, d) => d.watchers.some((u) => Number(u.id) === Number(app.boot.user.id));

  /**
   * Progress. The label names the basis, which is the whole point: hours booked
   * against an estimate and a status weight are different measurements, and a
   * reader has to know which one they are looking at.
   */
  function progress(d) {
    return h('div', [
      h('div.drawer-section', { text: 'Progress' }),
      h('div.meter-row', [
        h('div.meter', [h('i', {
          style: {
            width: pct(d.progress.pct),
            background: d.progress.basis === 'hours' ? 'var(--accent)' : 'var(--sel)',
          },
        })]),
        h('span.value', { text: `${d.progress.pct}%` }),
      ]),
      h('div.crumb', {
        style: { 'margin-top': '6px' },
        text: `${d.progress.label} · BASIS: ${d.progress.basis === 'hours' ? 'BOOKED AGAINST ESTIMATE' : 'STATUS WEIGHT'}`,
      }),
      d.timeEntries.length
        ? h('div.rows', { style: { 'margin-top': '10px' } }, d.timeEntries.slice(0, 5).map((t) => h('div.row', [
          h('span.tag.small', { style: { 'min-width': '70px' }, text: global.dom.shortDate(t.spent_on) }),
          h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-4)' }, text: t.comment || t.activity || '' }),
          h('span.tag.small', { text: `${nf(t.hours)} H` }),
          h('span.tag.small', { style: { color: 'var(--ink-6)' }, text: t.who }),
        ])))
        : null,
    ]);
  }

  /** Status and priority, changed in place. The transition list is the workflow. */
  function editControls(app, d) {
    if (!d.canEdit) {
      return h('p.note', { style: { margin: '16px 0 0' }, text: 'You may read this work package but not edit it.' });
    }
    const w = d.wp;
    return h('div', [
      h('div.drawer-section', { text: 'Change' }),
      h('div.pill-row', [
        ...app.boot.statuses
          .filter((s) => s.code !== w.status)
          .map((s) => h('button.pill', {
            style: { color: s.colour },
            title: 'Refused if the workflow does not allow it',
            onclick: () => app.act(
              () => global.api.patch(`/api/wp/${w.id}`, { status_id: s.id }),
              `${w.key} → ${s.label}`
            ).then(() => open(app, w.id)),
            text: `→ ${s.label}`,
          })),
      ]),
      h('div.pill-row', { style: { 'margin-top': '8px' } }, [
        ...app.boot.priorities
          .filter((p) => p.code !== w.priority)
          .map((p) => h('button.pill', {
            style: { color: p.colour },
            onclick: () => app.act(
              () => global.api.patch(`/api/wp/${w.id}`, { priority_id: p.id }),
              `Priority ${p.label}`
            ).then(() => open(app, w.id)),
            text: p.label,
          })),
      ]),
      h('div.pill-row', { style: { 'margin-top': '8px' } }, [
        h('button.pill', {
          onclick: () => editDates(app, d),
          text: 'DATES',
        }),
        h('button.pill', {
          onclick: () => editField(app, d, 'story_points', 'Story points (blank means not estimated, which is not zero)'),
          text: 'POINTS',
        }),
        h('button.pill', {
          onclick: () => editField(app, d, 'estimated_hours', 'Estimated work-hours'),
          text: 'ESTIMATE',
        }),
        h('button.pill', {
          onclick: () => app.act(
            () => global.api.patch(`/api/wp/${w.id}`, {
              scheduling: w.scheduling === 'manual' ? 'automatic' : 'manual',
            }),
            w.scheduling === 'manual' ? 'Now scheduled automatically' : 'Now holds its own dates'
          ).then(() => open(app, w.id)),
          text: w.scheduling === 'manual' ? '→ AUTOMATIC' : '→ MANUAL',
        }),
      ]),
    ]);
  }

  function relations(app, d) {
    const all = [
      ...(d.parent ? [{ kind: 'PARENT', key: d.parent.key, subject: d.parent.subject, id: d.parent.id }] : []),
      ...d.children.map((c) => ({ kind: 'CHILD', key: c.key, subject: c.subject, id: c.id, colour: c.colour })),
      ...d.relations.map((r) => ({ ...r, kind: r.kind.toUpperCase() })),
    ];
    return h('div', [
      h('div.drawer-section', { text: 'Relations' }),
      all.length
        ? h('div.rows', all.map((r) => h('div.row.clickable', {
          onclick: () => open(app, r.id),
        }, [
          h('span.tag.small', {
            style: {
              'min-width': '86px',
              color: r.kind === 'BLOCKS' || r.kind === 'BLOCKED BY' ? 'var(--blocked)' : 'var(--ink-5)',
            },
            text: r.kind,
          }),
          key(r.key),
          h('span.grow', { style: { 'font-size': '11.5px', color: 'var(--ink-4)' }, text: r.subject }),
        ])))
        : h('div', { style: { color: 'var(--ink-6)', 'font-size': '11.5px' }, text: 'no relations recorded' }),
    ]);
  }

  /**
   * What this work package is in the repository.
   *
   * Both halves are here because both are actionable: the key the repository
   * knows it by — which is what makes `F-LOAD-012 maps to PR #978` work at all —
   * and the objects that key has already found. A type that maps to something
   * and has no link says so in a sentence; an empty box would equally mean
   * "never pulled".
   */
  function repository(app, d) {
    const git = d.git;
    if (!git) {
      return h('div', [
        h('div.drawer-section', { text: 'Repository' }),
        h('div', { style: { color: 'var(--ink-6)', 'font-size': '11.5px' }, text: 'the repository panel could not be read' }),
      ]);
    }
    const live = git.links.filter((l) => !l.removed);
    const removed = git.links.filter((l) => l.removed);
    return h('div', [
      h('div.drawer-section', { text: 'Repository' }),
      h('dl.field-grid', [
        h('dt', { text: 'KNOWN AS' }),
        h('dd', [
          h('div', { style: { display: 'flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap' } }, [
            ...git.mapping.addressable_as.map((k) => key(k)),
            h('button.btn.small', {
              onclick: () => setRefKey(app, d, git),
              text: git.work_package.ref_key ? 'CHANGE KEY' : '+ REPOSITORY KEY',
            }),
          ]),
        ]),
        h('dt', { text: 'MAPS TO' }),
        h('dd', {
          style: { color: 'var(--ink-4)' },
          text: git.mapping.item_kind === 'none'
            ? `a ${git.work_package.type} has no forge counterpart, so nothing is expected here`
            : `${git.mapping.example || `a ${git.mapping.item_kind.replace('_', ' ')}`}`,
        }),
      ]),
      live.length
        ? h('div.rows', { style: { 'margin-top': '9px' } }, live.map((l) => h('div.row', [
          h('span.tag.small', { style: { 'min-width': '74px' }, text: l.relation.toUpperCase() }),
          h('div.grow', [
            l.url
              ? h('a', {
                href: l.url, target: '_blank', rel: 'noreferrer noopener',
                style: { 'font-size': '11.5px' },
                text: `${l.kind.replace('_', ' ')} ${l.ref} — ${l.title || '(no title)'}`,
              })
              : h('div', { style: { 'font-size': '11.5px' }, text: `${l.kind} ${l.ref}` }),
            h('div', {
              style: { 'font-size': '11px', color: 'var(--ink-5)' },
              // How the link came to exist, always. A regex and a person are
              // different claims and the row says which one this was.
              text: `${l.repository} · ${l.state}${l.head_branch ? ` · ${l.head_branch}` : ''} · `
                + (l.origin === 'manual'
                  ? `linked by hand${l.by ? ` by ${l.by}` : ''}`
                  : `matched on ${l.matched_key} in the ${l.matched_in}`)
                + ` · ${l.when}`,
            }),
          ]),
          h('button.btn.small.danger', {
            onclick: () => app.act(
              () => global.api.del(`/api/git-links/${l.id}`), 'Link removed'
            ).then(() => open(app, d.wp.id)),
            text: 'UNLINK',
          }),
        ])))
        : h('div', {
          style: { color: 'var(--ink-6)', 'font-size': '11.5px', 'margin-top': '9px' },
          text: git.mapping.item_kind === 'none'
            ? 'nothing linked, and nothing expected'
            : `no ${git.mapping.item_kind.replace('_', ' ')} carries this key yet`,
        }),
      git.revisions.length
        ? h('div', { style: { 'margin-top': '9px' } }, git.revisions.map((r) => h('div', {
          style: { 'font-size': '11px', color: 'var(--ink-5)', padding: '2px 0' },
          text: `${r.identifier} · ${r.message || ''} · ${r.author || 'unknown'} · ${r.when}`,
        })))
        : null,
      removed.length
        ? h('p.note', {
          style: { margin: '8px 0 0' },
          text: `${removed.length} link(s) removed by hand and kept: ${removed
            .map((l) => `${l.kind.replace('_', ' ')} ${l.ref}`).join(', ')}. `
            + 'A pull will not re-make them.',
        })
        : null,
      git.repositories.length
        ? h('button.btn.small', {
          style: { 'margin-top': '9px' },
          onclick: () => linkByHand(app, d, git),
          text: '+ LINK TO A PULL REQUEST OR ISSUE',
        })
        : h('p.note', { style: { margin: '8px 0 0' }, text: 'this project has no repository connected' }),
    ]);
  }

  function setRefKey(app, d, git) {
    const value = prompt(
      'The key this work package is known by in the repository. It is matched in pull request '
      + 'titles, bodies and branch names — F-LOAD-012, B-UI-7. Empty clears it.',
      git.work_package.ref_key || ''
    );
    if (value === null) return;
    app.act(
      () => global.api.post(`/api/wp/${d.wp.id}/ref-key`, { ref_key: value.trim() }),
      value.trim() ? `Known as ${value.trim().toUpperCase()}` : 'Repository key cleared'
    ).then(() => open(app, d.wp.id));
  }

  function linkByHand(app, d, git) {
    const kind = prompt('What kind — pull_request, issue, milestone or release?', git.mapping.item_kind === 'none'
      ? 'pull_request' : git.mapping.item_kind);
    if (!kind) return;
    const ref = prompt(`Which ${kind.replace('_', ' ')}? Its number, or a release tag.`, '');
    if (!ref) return;
    app.act(
      () => global.api.post(`/api/wp/${d.wp.id}/git-links`, {
        kind: kind.trim(), ref: ref.trim(),
        repository_id: git.repositories.length === 1 ? git.repositories[0].id : undefined,
      }),
      'Linked'
    ).then(() => open(app, d.wp.id));
  }

  function customValues(d) {
    if (!d.customValues.length) return null;
    return h('div', [
      h('div.drawer-section', { text: 'Custom attributes' }),
      h('dl.field-grid', d.customValues.flatMap((c) => [
        h('dt', { title: c.help_text || '', text: c.name.toUpperCase() }),
        h('dd', [
          h('div', { text: c.value || '—' }),
          // The help text is the field's documentation and belongs beside the
          // value, which is the only place anybody reads it.
          c.help_text
            ? h('div', { style: { 'font-size': '10.5px', color: 'var(--ink-6)', 'margin-top': '2px' }, text: c.help_text })
            : null,
        ]),
      ])),
    ]);
  }

  function files(app, d) {
    const input = h('input', {
      type: 'file', multiple: true,
      style: { display: 'none' },
      onchange: async (e) => {
        const form = new FormData();
        for (const f of e.target.files) form.append('file', f);
        await app.act(() => global.api.post(`/api/wp/${d.wp.id}/attachments`, form), 'Attached');
        open(app, d.wp.id);
      },
    });
    return h('div', [
      h('div.drawer-section', { text: 'Files' }),
      d.files.length
        ? h('div.rows', d.files.map((f) => h('div.row', [
          h('span.tag.small', {
            style: { 'min-width': '46px' },
            text: (f.filename.split('.').pop() || '').toUpperCase().slice(0, 5),
          }),
          h('a.grow', {
            href: `/api/attachments/${f.id}`,
            style: { 'font-size': '11.5px' },
            text: f.filename,
          }),
          h('span.tag.small', { style: { color: 'var(--ink-6)' }, text: f.size }),
        ])))
        : h('div', { style: { color: 'var(--ink-6)', 'font-size': '11.5px' }, text: 'no files' }),
      input,
      h('button.btn.small', {
        style: { 'margin-top': '9px' },
        onclick: () => input.click(),
        text: '+ ATTACH',
      }),
    ]);
  }

  function shares(app, d) {
    const live = d.shares.filter((s) => !s.revoked);
    return h('div', [
      h('div.drawer-section', { text: 'Shared outside the project' }),
      live.length
        ? h('div.rows', live.map((s) => h('div.row', [
          h('span.tag.small', { style: { 'min-width': '60px' }, text: s.permission.toUpperCase() }),
          h('div.grow', [
            h('a', { href: s.url, style: { 'font-size': '11.5px' }, text: `${location.origin}${s.url}` }),
            h('div', {
              style: { 'font-size': '11px', color: 'var(--ink-5)' },
              text: `${s.email || 'anyone with the link'} · expires ${String(s.expires_at || '').slice(0, 10) || 'never'}`
                + ` · ${s.views} view(s)`,
            }),
          ]),
          h('button.btn.small.danger', {
            onclick: () => app.act(() => global.api.del(`/api/shares/${s.id}`), 'Link revoked').then(() => open(app, d.wp.id)),
            text: 'REVOKE',
          }),
        ])))
        : h('div', { style: { color: 'var(--ink-6)', 'font-size': '11.5px' }, text: 'not shared' }),
      h('button.btn.small', {
        style: { 'margin-top': '9px' },
        onclick: () => share(app, d),
        text: '+ SHARE LINK',
      }),
      h('p.note', {
        style: { margin: '8px 0 0' },
        text: 'A share link needs no account. Internal comments are never included in one, at any '
          + 'permission level.',
      }),
    ]);
  }

  function comments(app, d) {
    const box = h('textarea', {
      placeholder: 'comment — @mention to notify',
      'aria-label': 'Comment',
    });
    const internal = h('input', { type: 'checkbox' });
    const send = async () => {
      const body = box.value.trim();
      if (!body) return;
      const out = await app.act(
        () => global.api.post(`/api/wp/${d.wp.id}/comments`, { body, internal: internal.checked }),
        null
      );
      if (!out) return;
      if (out.unresolved && out.unresolved.length) {
        // A mention that reached nobody is reported. A silent no-op mention is
        // how a question goes unanswered for a week.
        app.toast(`Posted, but @${out.unresolved.join(', @')} matched nobody.`, 'bad');
      } else if (out.mentioned.length) {
        app.toast(`Posted and notified ${out.mentioned.join(', ')}.`, 'good');
      } else {
        app.toast('Posted.', 'good');
      }
      box.value = '';
      open(app, d.wp.id);
    };

    return h('div', [
      h('div.drawer-section', {
        text: d.canSeeInternal ? 'Comments' : 'Comments (internal ones are hidden from you)',
      }),
      ...d.comments.map((c) => h('div.comment' + (c.internal ? '.internal' : ''), [
        h('div.top', [
          h('span.who', { text: c.author || 'somebody' }),
          h('span.tag.small', {
            style: { color: c.internal ? 'var(--accent)' : 'var(--ink-5)' },
            text: c.internal ? 'INTERNAL' : 'COMMENT',
          }),
          h('div.spacer'),
          h('span.when', { text: `${c.when} AGO` }),
        ]),
        h('div.body', { text: c.body }),
      ])),
      h('div.composer', [
        box,
        h('div.side', [
          h('button.btn.primary.small', { onclick: send, text: 'SEND' }),
          d.canSeeInternal
            ? h('label.check', [internal, 'INTERNAL'])
            : null,
        ]),
      ]),
    ]);
  }

  // ------------------------------------------------------------------- actions

  function editDates(app, d) {
    const w = d.wp;
    if (w.is_milestone) {
      const due = prompt('A milestone has one date. Due (YYYY-MM-DD):', w.due_date || '');
      if (!due) return;
      app.act(() => global.api.patch(`/api/wp/${w.id}`, { due_date: due, start_date: due }), 'Dates set')
        .then(() => open(app, w.id));
      return;
    }
    const start = prompt('Start (YYYY-MM-DD, blank to clear):', w.start_date || '');
    if (start === null) return;
    const due = prompt('Due (YYYY-MM-DD, blank to clear):', w.due_date || '');
    if (due === null) return;
    app.act(
      () => global.api.patch(`/api/wp/${w.id}`, { start_date: start || null, due_date: due || null }),
      'Dates set'
    ).then(() => open(app, w.id));
  }

  function editField(app, d, field, label) {
    const current = d.wp[field === 'story_points' ? 'story_points' : 'estimated_hours'];
    const value = prompt(label + ':', current === null ? '' : String(current));
    if (value === null) return;
    app.act(
      () => global.api.patch(`/api/wp/${d.wp.id}`, { [field]: value === '' ? null : Number(value) }),
      'Saved'
    ).then(() => open(app, d.wp.id));
  }

  async function share(app, d) {
    const email = prompt('Email to send it to (optional — leave blank for a link anyone can use):') || null;
    const permission = prompt('Permission — view, comment or edit:', 'view');
    if (!permission) return;
    const days = prompt('Expires in how many days?', '30');
    const out = await app.act(
      () => global.api.post(`/api/wp/${d.wp.id}/share`, { email, permission, days: Number(days) || 30 }),
      'Share link created — internal comments are not in it'
    );
    if (out) open(app, d.wp.id);
  }

  global.drawer = { open, close };
}(window));
