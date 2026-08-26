/*
 * Wiki & documents.
 *
 * Editing is live-presence plus optimistic concurrency, and the app is explicit
 * about which of those it is. Two people in the same document see each other in
 * the rail; a save against a stale revision is REFUSED with the other version
 * offered, never merged. A silent merge that picks one author is the failure this
 * refuses to have, and claiming character-level collaboration we do not do would
 * be worse than doing less.
 */

(function (global) {
  'use strict';

  const { h, key, avatar, nf } = global.dom;

  let presenceTimer = null;

  global.viewWiki = async function viewWiki(app) {
    const slug = app.state.params.doc || null;
    const data = await global.api.get(`/api/wiki${global.api.qs({ project: app.state.project, doc: slug })}`);

    clearInterval(presenceTimer);
    if (data.current) {
      // A heartbeat, not a lock. It says "somebody is in here", which is what
      // makes the collision visible before it happens.
      const ping = () => global.api.post(`/api/documents/${data.current.id}/presence`, {
        base_revision: data.current.revision,
      }).catch(() => {});
      ping();
      presenceTimer = setInterval(ping, 45000);
    }

    return h('div.wiki', [
      h('div.wiki-rail', [
        h('div.rail-head', { text: 'Documents' }),
        ...data.docs.map((d) => h('button.wiki-doc' + (data.current && d.id === data.current.id ? '.is-current' : ''), {
          onclick: () => app.setParam('doc', d.slug),
        }, [
          h('span.num', { text: d.number || '' }),
          h('span.title', { text: d.title }),
          d.editing
            ? h('span.status', { style: { color: 'var(--ok)' }, text: `${d.editing} LIVE` })
            : h('span.status', {
              style: { color: d.status === 'SPEC' ? 'var(--ok)' : 'var(--sel)' },
              text: d.status,
            }),
        ])),
        h('div.rail-head', { style: { 'padding-top': '20px' }, text: 'Also here' }),
        h('div', {
          style: { padding: '0 8px', display: 'flex', 'flex-direction': 'column', gap: '7px', 'font-size': '11.5px', color: 'var(--ink-4)' },
        }, [
          h('div', { text: `Forums · ${data.alsoHere.forums} thread(s)` }),
          h('div', { text: `News · ${data.alsoHere.news} post(s)` }),
          h('div', { text: `Files · ${data.alsoHere.attachments} attachment(s)` }),
          data.alsoHere.xwiki
            ? h('a', {
              href: data.alsoHere.xwiki.target || '#',
              rel: 'noopener noreferrer',
              text: `XWiki space · ${data.alsoHere.xwiki.state}`,
            })
            : h('div', { style: { color: 'var(--ink-6)' }, text: 'XWiki · not configured' }),
        ]),
      ]),

      h('div.wiki-body', [
        h('div.crumb', {
          style: { 'margin-bottom': '14px' },
          text: data.current
            ? `WIKI / ${data.current.number || ''} / ${data.current.title.toUpperCase()}`.replace(/\s+\/\s+\//, ' /')
            : 'WIKI',
        }),
        data.current
          ? h('div.prose', { id: 'doc-body' }, [
            ...global.md.render(data.current.body || '_This document is empty._'),
            h('div', { style: { 'margin-top': '26px', display: 'flex', gap: '8px' } }, [
              h('button.btn', { onclick: () => edit(app, data), text: 'EDIT' }),
              h('button.btn', { onclick: () => app.render(), text: 'REFRESH' }),
            ]),
          ])
          : h('div.empty', { text: 'no documents in scope' }),
      ]),

      h('div.wiki-rail.right', [
        h('div.label', { style: { 'margin-bottom': '9px' }, text: 'Article' }),
        data.current
          ? h('dl.wiki-meta', { style: { 'margin-bottom': '22px' } }, [
            h('dt', { text: 'STATUS' }), h('dd', { text: data.current.status }),
            h('dt', { text: 'WORDS' }), h('dd', { text: nf(data.current.word_count, '0') }),
            h('dt', { text: 'SECTIONS' }), h('dd', { text: nf(data.current.section_count, '0') }),
            h('dt', { text: 'REVISION' }), h('dd', { text: String(data.current.revision) }),
            h('dt', { text: 'EDITING' }),
            h('dd', {
              style: { color: data.editors.length ? 'var(--ok)' : 'var(--ink-5)' },
              text: data.editors.length
                ? `${data.editors.length} other${data.editors.length === 1 ? '' : 's'} live`
                : 'you only',
            }),
          ])
          : null,
        data.editors.length
          ? h('div', { style: { display: 'flex', gap: '6px', 'margin-bottom': '22px' } },
            data.editors.map((e) => avatar(e)))
          : null,

        h('div.label', { style: { 'margin-bottom': '9px' }, text: 'News' }),
        h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '11px', 'margin-bottom': '22px' } },
          data.news.length
            ? data.news.map((n) => h('div', [
              h('div', { style: { 'font-size': '11.5px', color: 'var(--ink-2)' }, text: n.title }),
              h('div', {
                style: { font: '400 9.5px var(--font-label)', 'letter-spacing': '.09em', color: 'var(--ink-6)' },
                text: `${String(n.when).toUpperCase()} AGO · ${String(n.author || '').toUpperCase()}`,
              }),
            ]))
            : [h('div', { style: { color: 'var(--ink-6)', 'font-size': '11.5px' }, text: 'no news' })]),

        h('div.label', { style: { 'margin-bottom': '9px' }, text: 'Forums' }),
        h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '8px', 'font-size': '11.5px', color: 'var(--ink-4)' } },
          data.topics.length
            ? data.topics.map((t) => h('div', { text: `${t.subject} · ${t.reply_count} repl${t.reply_count === 1 ? 'y' : 'ies'}` }))
            : [h('div', { style: { color: 'var(--ink-6)' }, text: 'no threads' })]),
      ]),
    ]);
  };

  /**
   * Editing, in place.
   *
   * The textarea replaces the rendered body and carries the revision it started
   * from. A conflicting save comes back with the other version, and the app
   * offers both rather than choosing.
   */
  function edit(app, data) {
    const host = document.getElementById('doc-body');
    if (!host) return;
    const base = data.current.revision;
    const area = h('textarea', {
      style: {
        width: '100%', 'min-height': '60vh', background: 'rgba(255,255,255,.04)',
        border: '1px solid var(--line-3)', 'border-radius': '6px', color: 'var(--ink)',
        padding: '14px 16px', font: '400 12.5px/1.75 var(--font-label)', outline: 'none', resize: 'vertical',
      },
      'aria-label': 'Document source',
    });
    area.value = data.current.body || '';

    const save = h('button.btn.primary', {
      text: 'SAVE',
      onclick: async () => {
        try {
          const out = await global.api.patch(`/api/documents/${data.current.id}`, {
            body: area.value, base_revision: base,
          });
          app.toast(`Saved as revision ${out.revision} · ${out.word_count} words`, 'good');
          app.render();
        } catch (e) {
          if (e.status === 409 && e.payload && e.payload.currentBody !== undefined) {
            conflict(app, data, area, base, e);
            return;
          }
          app.toast(e.message, 'bad');
        }
      },
    });

    global.dom.fill(host, [
      h('p.note', {
        style: { margin: '0 0 12px' },
        text: `Editing revision ${base}. Markdown. A save against a stale revision is refused with the `
          + 'other version offered — nothing is merged silently.',
      }),
      area,
      h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '12px' } }, [
        save,
        h('button.btn', { onclick: () => app.render(), text: 'CANCEL' }),
      ]),
    ]);
    area.focus();
  }

  function conflict(app, data, area, base, error) {
    const theirs = error.payload.currentBody || '';
    const now = error.payload.currentRevision;
    app.toast(error.message, 'bad');
    const host = document.getElementById('doc-body');
    if (!host) return;
    const theirArea = h('textarea', {
      readonly: true,
      style: {
        width: '100%', 'min-height': '30vh', background: 'rgba(210,112,95,.05)',
        border: '1px solid var(--blocked-dim)', 'border-radius': '6px', color: 'var(--ink-3)',
        padding: '12px 14px', font: '400 12px/1.7 var(--font-label)', resize: 'vertical',
      },
      'aria-label': `Revision ${now} as saved by somebody else`,
    });
    theirArea.value = theirs;
    host.appendChild(h('div', { style: { 'margin-top': '20px' } }, [
      h('div.label', { style: { color: 'var(--blocked)', 'margin-bottom': '8px' }, text: `Revision ${now} — saved by somebody else` }),
      theirArea,
      h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '10px' } }, [
        h('button.btn.danger', {
          text: 'OVERWRITE WITH MINE',
          onclick: async () => {
            await app.act(() => global.api.patch(`/api/documents/${data.current.id}`, {
              body: area.value, base_revision: now,
              note: `overwrote revision ${now} after a conflict`,
            }), 'Saved over the other revision');
          },
        }),
        h('button.btn', {
          text: 'TAKE THEIRS',
          onclick: () => { area.value = theirs; app.toast('Their text is now in the editor — save to keep it.'); },
        }),
      ]),
    ]));
  }
}(window));
