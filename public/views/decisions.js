/*
 * Decisions.
 *
 * A decision used to be a wiki page; now it is a record with two explicit
 * links — decision -> work package (who is waiting) and decision -> decision
 * (who gates whom) — and this screen draws both rather than leaving them to be
 * inferred from prose. The API shape is fixed (see the spec); nothing here
 * computes a percentage or holds state the URL does not also carry.
 *
 * RUST IS RESERVED. An open decision draws in rust only while it is blocking
 * live work (`blocksCount > 0`); an open decision blocking nothing draws in
 * amber, because open is not itself the reserved condition — a person waiting
 * on it is. Settled is green, superseded is dimmed to ink. Nothing else on
 * this screen uses rust.
 *
 * WHO MAY WRITE. `/api/bootstrap` carries no per-project permission the
 * browser can read — work.js and deck.js do not hide a write control on that
 * basis either, they let the server refuse and show its reason. Every control
 * below does the same: it is always drawn, and a refusal (`you do not have
 * "record_decisions" on this project`) surfaces as the toast `app.act` already
 * produces, rather than a client-side guess this screen has no data to make.
 */

(function (global) {
  'use strict';

  const { h, fill, key, tag, kpi, shortDate } = global.dom;

  const RELATION_LABEL = { blocks: 'BLOCKS', informs: 'INFORMS', arose_from: 'AROSE FROM' };

  global.viewDecisions = async function viewDecisions(app) {
    const data = await global.api.get(`/api/decisions${global.api.qs({
      project: app.state.project, decision: app.state.params.decision,
    })}`);

    // Looked up by ref so the gating buttons and the whole-graph rows can use
    // the full colour rule (it needs blocksCount, which only the scoped list
    // carries) rather than falling back to state alone.
    const byRef = new Map(data.decisions.map((d) => [d.ref, d]));

    return h('div.decisions', [
      h('div.decisions-rail', [
        h('div.rail-head', { text: 'Decisions' }),
        h('button.btn.small', {
          style: { margin: '0 8px 12px' },
          onclick: () => newDecision(app),
          text: '+ NEW DECISION',
        }),
        data.decisions.length
          ? h('div', data.decisions.map((d) => decisionItem(app, d, data.current)))
          : h('div.empty', { text: 'no decisions in scope' }),
      ]),

      h('div.decisions-body', [
        data.current ? body(app, data.current) : h('div.empty', { text: 'no decision to show' }),
      ]),

      h('div.decisions-rail.right', [
        data.current ? rightRail(app, data, byRef) : null,
      ]),
    ]);
  };

  // ------------------------------------------------------------------- left rail

  function decisionItem(app, d, current) {
    return h('button.decisions-item' + (current && current.ref === d.ref ? '.is-current' : ''), {
      onclick: () => app.setParam('decision', d.ref),
    }, [
      h('div.top', [
        key(d.ref),
        h('span.title', { text: d.title }),
        tag(d.state.toUpperCase(), stateColour(d), true),
      ]),
      h('div.hold', { text: holdLine(d) }),
    ]);
  }

  /** The sentence the row is judged by, rather than a raw count with no verb. */
  function holdLine(d) {
    const parts = [d.blocksCount ? `blocks ${d.blocksCount}` : 'blocks nothing'];
    if (d.waitingOn && d.waitingOn.length) parts.push(`waits on ${d.waitingOn.join(', ')}`);
    return parts.join(' · ');
  }

  /** Raise a decision, then go straight to it — there is nothing else to do
   *  with a freshly raised one until it has a question worth reading. */
  async function newDecision(app) {
    const ref = prompt(
      'Ref — one letter to start, then letters, digits or dashes, up to 24 characters (e.g. D-14):'
    );
    if (!ref) return;
    const title = prompt('Title, phrased as a question:');
    if (!title) return;
    const created = await app.act(
      () => global.api.post('/api/decisions', {
        project_id: app.state.project, ref: ref.trim(), title: title.trim(),
      }),
      'Raised'
    );
    if (created) app.setParam('decision', created.ref);
  }

  // ---------------------------------------------------------------------- body

  function body(app, current) {
    return [
      h('div.crumb', {
        style: { 'margin-bottom': '14px' },
        text: `DECISIONS / ${current.ref} / ${current.title.toUpperCase()}`,
      }),

      metaBlock(current),

      current.canSettle && !current.canSettle.ok
        ? h('p.note', { style: { color: 'var(--blocked)' }, text: current.canSettle.reason })
        : null,

      h('div.prose', { id: 'decision-body' }, [
        h('div.drawer-section', { text: 'The question' }),
        ...global.md.render(current.question || '_no question recorded_'),

        h('div.drawer-section', { text: 'What was decided' }),
        current.answer
          ? global.md.render(current.answer)
          : [h('p', {
            text: current.state === 'open'
              ? 'NO ANSWER YET — THIS IS OPEN AND SOMETHING IS WAITING ON IT'
              : 'no answer recorded',
          })],

        current.rationale ? h('div.drawer-section', { text: 'Why' }) : null,
        current.rationale ? global.md.render(current.rationale) : null,
      ]),

      waitingPanel(app, current),

      actions(app, current),
    ];
  }

  function metaBlock(current) {
    const rows = [
      ['STATE', current.state.toUpperCase()],
      ['OWNER', current.owner || '—'],
      ['DUE', shortDate(current.due_on)],
    ];
    if (current.state !== 'open') {
      // decided_at is a DATETIME and arrives as '2026-08-26 10:00:00'. shortDate
      // splits on the dash and would read the day as '26 10:00:00', so the time
      // is cut here rather than teaching shortDate about a second format.
      rows.push(['DECIDED', current.decided_at
        ? `${shortDate(String(current.decided_at).slice(0, 10))} · ${current.decided_by_name || '—'}`
        : '—']);
    }
    if (current.state === 'superseded' && current.superseded_by_ref) {
      rows.push(['SUPERSEDED', `by ${current.superseded_by_ref}`]);
    }
    rows.push(['FROM', current.document
      ? `${current.document.number ? current.document.number + ' — ' : ''}${current.document.title}`
      : 'not from a document']);
    return h('dl.wiki-meta', { style: { 'margin-bottom': '18px' } },
      rows.flatMap(([dt, dd]) => [h('dt', { text: dt }), h('dd', { text: dd })]));
  }

  /** Every live link, grouped the way the type maps to it — never blank — plus
   *  the control that makes a new one. */
  function waitingPanel(app, current) {
    const groups = groupWork(current.work);
    const order = ['FEATURES', 'BUGS & TASKS', 'EVERYTHING ELSE'].filter((g) => groups[g].length);
    return h('div', { style: { 'margin-top': '8px' } }, [
      h('div.drawer-section', { text: 'What is waiting on this' }),
      order.length
        ? order.map((g) => h('div', { style: { 'margin-bottom': '14px' } }, [
          h('div.label', { style: { 'margin-bottom': '4px' }, text: g }),
          h('div', groups[g].map((w) => workRow(app, current, w))),
        ]))
        : h('div.empty', { text: 'nothing is waiting on this decision' }),
      linkWorkForm(app, current),
    ]);
  }

  function groupWork(work) {
    const groups = { FEATURES: [], 'BUGS & TASKS': [], 'EVERYTHING ELSE': [] };
    for (const relation of ['blocks', 'informs', 'arose_from']) {
      for (const row of (work[relation] || [])) {
        groups[categoryFor(row.type)].push({ ...row, relation });
      }
    }
    return groups;
  }

  /** FEATURE and BUG/TASK are the two callers most often ask after; everything
   *  else (EPIC, MILESTONE, PHASE, or a custom type) is one bucket rather than
   *  a row per type, because the point is what waits, not a type census. */
  function categoryFor(type) {
    const t = String(type || '').toUpperCase();
    if (t === 'FEATURE') return 'FEATURES';
    if (t === 'BUG' || t === 'TASK') return 'BUGS & TASKS';
    return 'EVERYTHING ELSE';
  }

  function workRow(app, current, w) {
    return h('div.decisions-work-row', [
      h('div', { style: { cursor: 'pointer' }, onclick: () => app.openWp(w.id) }, [
        h('div', { style: { display: 'flex', 'align-items': 'baseline', gap: '9px', 'flex-wrap': 'wrap' } }, [
          key(w.wp_key || ''),
          h('span.subject', { text: w.subject }),
          tag(w.status_label, w.status_colour, true),
          h('span.tag.small', { style: { color: 'var(--ink-5)' }, text: RELATION_LABEL[w.relation] }),
        ]),
        // A matcher's claim is a key found by a regex; a person's link is a
        // decision. The two are never drawn the same, so this line only exists
        // on a matcher's row.
        w.origin === 'matcher'
          ? h('div', {
            style: { 'font-size': '10.5px', color: 'var(--ink-6)', 'margin-top': '3px' },
            text: `matched from the Decision ref field${w.matched_in ? ` (${w.matched_in})` : ''}`,
          })
          : null,
        w.note
          ? h('div', { style: { 'font-size': '10.5px', color: 'var(--ink-5)', 'margin-top': '2px' }, text: w.note })
          : null,
      ]),
      h('button.btn.small.danger', {
        style: { 'margin-top': '5px' },
        onclick: () => app.act(
          () => global.api.del(`/api/decisions/${current.id}/work/${w.id}`),
          `${w.wp_key} unlinked from ${current.ref} — the row is kept, not deleted`
        ),
        text: 'UNLINK',
      }),
    ]);
  }

  /** Link an existing work package by id or by its WP key — WP-124 and 124
   *  mean the same work package, so either is accepted. */
  function linkWorkForm(app, current) {
    const idInput = h('input', { type: 'text', placeholder: 'WP-124 or 124', 'aria-label': 'Work package' });
    const relationSelect = h('select', { 'aria-label': 'Relation' }, [
      h('option', { value: 'blocks', text: 'BLOCKS' }),
      h('option', { value: 'informs', text: 'INFORMS' }),
      h('option', { value: 'arose_from', text: 'AROSE FROM' }),
    ]);
    return h('div.decisions-link-form', [
      idInput,
      relationSelect,
      h('button.btn.small', {
        onclick: () => {
          const raw = idInput.value.trim();
          const id = Number(raw.replace(/^wp-/i, ''));
          if (!raw || !Number.isInteger(id) || id <= 0) {
            app.toast('give a work package id or key, like WP-124', 'bad');
            return;
          }
          app.act(
            () => global.api.post(`/api/decisions/${current.id}/work`, {
              work_package_id: id, relation: relationSelect.value,
            }),
            'Linked'
          );
        },
        text: '+ LINK WORK',
      }),
    ]);
  }

  // ---------------------------------------------------------------- manage box

  /** Settle / re-open, and edit — the two things this screen writes about the
   *  decision itself rather than its links. Both PATCH through `saveDecision`
   *  so the route is called from one place regardless of which control fired. */
  function actions(app, current) {
    const settleDisabled = Boolean(current.canSettle && !current.canSettle.ok);
    return h('div.decisions-actions', [
      current.state === 'open'
        ? h('button.btn.primary.small', {
          disabled: settleDisabled ? true : null,
          onclick: () => settleEditor(app, current),
          text: 'SETTLE',
        })
        : h('button.btn.small', {
          onclick: () => saveDecision(app, current, { state: 'open' }, `${current.ref} re-opened`),
          text: 'RE-OPEN',
        }),
      h('button.btn.small', { onclick: () => editDecision(app, current), text: 'EDIT' }),
    ]);
  }

  /** The one place `/api/decisions/:id` is PATCHed from. Settling, re-opening
   *  and editing all call this rather than each holding its own fetch. */
  function saveDecision(app, current, patch, successMessage) {
    return app.act(() => global.api.patch(`/api/decisions/${current.id}`, patch), successMessage);
  }

  /**
   * Settling, in place.
   *
   * A settled decision with no answer is the thing this record type exists to
   * prevent, so the answer is written here, first, and only sent once it is
   * not empty — refused client-side with the same sentence a person would be
   * told twice otherwise.
   */
  function settleEditor(app, current) {
    const host = document.getElementById('decision-body');
    if (!host) return;
    const area = h('textarea', { 'aria-label': 'What was decided' });
    area.value = current.answer || '';

    const save = h('button.btn.primary', {
      text: 'SETTLE',
      onclick: () => {
        const answer = area.value.trim();
        if (!answer) {
          app.toast('A DECISION IS SETTLED WHEN SOMEBODY CAN ACT ON THE ANSWER — WRITE ONE FIRST', 'bad');
          return;
        }
        saveDecision(app, current, { answer, state: 'settled' }, `${current.ref} settled`);
      },
    });

    fill(host, [
      h('p.note', {
        style: { margin: '0 0 12px' },
        text: 'Settling records the answer. Write it below — a decision with no answer is not settled.',
      }),
      h('div.decisions-field', [area]),
      h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '10px' } }, [
        save,
        h('button.btn', { onclick: () => app.render(), text: 'CANCEL' }),
      ]),
    ]);
    area.focus();
  }

  /**
   * Editing, in place.
   *
   * Follows `wiki.js`'s idiom: the rendered body is replaced by fields, and
   * only the ones that changed are sent. The owner field has no name to
   * prefill against — the read side (`views6.js`) hands this screen a name,
   * not the id it came from — so it starts blank and is left out of the patch
   * unless somebody types a new id; the placeholder says whose id is current.
   */
  function editDecision(app, current) {
    const host = document.getElementById('decision-body');
    if (!host) return;

    const titleInput = h('input', { type: 'text', 'aria-label': 'Title' });
    titleInput.value = current.title || '';
    const questionArea = h('textarea', { 'aria-label': 'The question' });
    questionArea.value = current.question || '';
    const answerArea = h('textarea', { 'aria-label': 'What was decided' });
    answerArea.value = current.answer || '';
    const rationaleArea = h('textarea', { 'aria-label': 'Why' });
    rationaleArea.value = current.rationale || '';
    const ownerInput = h('input', {
      type: 'number', 'aria-label': 'Owner',
      placeholder: `leave blank to keep ${current.owner || 'no owner'}`,
    });
    const dueInput = h('input', { type: 'date', 'aria-label': 'Due' });
    dueInput.value = current.due_on || '';

    const save = h('button.btn.primary', {
      text: 'SAVE',
      onclick: () => {
        const changes = {};
        if (titleInput.value.trim() !== (current.title || '')) changes.title = titleInput.value.trim();
        if (questionArea.value !== (current.question || '')) changes.question = questionArea.value;
        if (answerArea.value !== (current.answer || '')) changes.answer = answerArea.value;
        if (rationaleArea.value !== (current.rationale || '')) changes.rationale = rationaleArea.value;
        if (ownerInput.value.trim()) changes.owner_id = Number(ownerInput.value.trim());
        if (dueInput.value !== (current.due_on || '')) changes.due_on = dueInput.value;
        if (!Object.keys(changes).length) {
          app.toast('nothing to change', 'bad');
          return;
        }
        saveDecision(app, current, changes, 'Saved');
      },
    });

    fill(host, [
      field('Title', titleInput),
      field('The question', questionArea),
      field('What was decided', answerArea),
      field('Why', rationaleArea),
      field('Owner — person id', ownerInput),
      field('Due', dueInput),
      h('div', { style: { display: 'flex', gap: '8px', 'margin-top': '10px' } }, [
        save,
        h('button.btn', { onclick: () => app.render(), text: 'CANCEL' }),
      ]),
    ]);
    titleInput.focus();
  }

  function field(label, input) {
    return h('div.decisions-field', [
      h('div.label', { style: { margin: '0 0 4px' }, text: label.toUpperCase() }),
      input,
    ]);
  }

  // -------------------------------------------------------------------- right rail

  function rightRail(app, data, byRef) {
    const current = data.current;
    return [
      h('div.label', { style: { 'margin-bottom': '9px' }, text: 'The gating chain' }),

      h('div.label', { style: { 'margin-bottom': '5px' }, text: 'This waits on' }),
      current.dependsOn.length
        ? h('div', { style: { 'margin-bottom': '9px' } }, current.dependsOn.map((entry) => dependsOnRow(app, current, entry, byRef)))
        : h('div.empty', { style: { padding: '6px 0' }, text: 'waits on nothing' }),
      dependencyForm(app, current, data.decisions),

      h('div.label', { style: { 'margin-bottom': '5px' }, text: 'These wait on this' }),
      current.gates.length
        ? h('div', { style: { 'margin-bottom': '18px' } }, current.gates.map((entry) => gateButton(app, entry, byRef)))
        : h('div.empty', { style: { padding: '6px 0 18px' }, text: 'nothing gates on this' }),

      kpiStrip(data.kpis),

      h('div.label', { style: { 'margin': '18px 0 9px' }, text: 'The whole graph' }),
      chain(app, data.chain, byRef),
    ];
  }

  function gateButton(app, entry, byRef) {
    const colour = stateColour(byRef.get(entry.ref) || entry);
    return h('button.decisions-gate-btn', {
      style: { 'border-left': `2px solid ${colour}` },
      onclick: () => app.setParam('decision', entry.ref),
    }, [
      h('div', [key(entry.ref), ' ', entry.title]),
      entry.note ? h('div', { style: { 'font-size': '10px', color: 'var(--ink-6)', 'margin-top': '2px' }, text: entry.note }) : null,
    ]);
  }

  /** Same row as `gateButton`, plus the REMOVE control this direction of the
   *  edge carries — the other direction ("these wait on this") has none,
   *  because removing a gate is always done from the decision that is waiting,
   *  the same way `removeDependency` is addressed: by the waiting decision. */
  function dependsOnRow(app, current, entry, byRef) {
    const colour = stateColour(byRef.get(entry.ref) || entry);
    return h('div.decisions-gate-btn', { style: { 'border-left': `2px solid ${colour}` } }, [
      h('div', { style: { display: 'flex', 'align-items': 'flex-start', gap: '8px' } }, [
        h('button.decisions-chain-link', {
          style: { flex: '1', 'text-align': 'left', 'white-space': 'normal' },
          onclick: () => app.setParam('decision', entry.ref),
          text: `${entry.ref} — ${entry.title}`,
        }),
        h('button.btn.small.danger', {
          onclick: () => app.act(
            () => global.api.del(`/api/decisions/${current.id}/depends/${entry.id}`),
            `${current.ref} no longer waits on ${entry.ref} — the row is kept, not deleted`
          ),
          text: 'REMOVE',
        }),
      ]),
      entry.note ? h('div', { style: { 'font-size': '10px', color: 'var(--ink-6)', 'margin-top': '2px' }, text: entry.note }) : null,
    ]);
  }

  /** Gate this decision on another one, picked by ref rather than typed —
   *  the ref has to already exist in scope, so a picker cannot be wrong the
   *  way a typed one could. A cycle is refused server-side and its message,
   *  which names the path, is shown exactly as returned. */
  function dependencyForm(app, current, decisions) {
    const options = decisions.filter((d) => d.id !== current.id);
    if (!options.length) {
      return h('p.note', { style: { margin: '0 0 16px' }, text: 'no other decision in scope to wait on' });
    }
    const select = h('select', { 'aria-label': 'Depends on which decision' },
      options.map((d) => h('option', { value: d.id, text: `${d.ref} — ${d.title}` })));
    return h('div.decisions-depend-form', [
      select,
      h('button.btn.small', {
        onclick: () => app.act(
          () => global.api.post(`/api/decisions/${current.id}/depends`, { depends_on_id: Number(select.value) }),
          'Added'
        ),
        text: '+ WAITS ON',
      }),
    ]);
  }

  /** Stacked, not the four-column strip portfolio.js uses — the right rail is
   *  244px wide and a four-column grid there is the overflow this screen is
   *  told never to have. */
  function kpiStrip(k) {
    return h('div.decisions-kpis', [
      kpi('OPEN', String(k.open), null),
      kpi('SETTLED', String(k.settled), null, 'ok'),
      kpi('SUPERSEDED', String(k.superseded), null),
      kpi('WORK BLOCKED', String(k.blockedWork), 'live "blocks" link to an open decision',
        k.blockedWork ? 'blocked' : 'plain'),
      kpi('OLDEST OPEN', k.oldestOpenDays === null ? '—' : `${k.oldestOpenDays}d`, null),
      kpi('CHAINED', String(k.chained), 'open, waiting on another open decision'),
    ]);
  }

  /** The whole graph, layered so the order the answers have to arrive in is
   *  visible rather than implied by a flat list. */
  function chain(app, entries, byRef) {
    const layers = new Map();
    for (const c of entries) {
      if (!layers.has(c.layer)) layers.set(c.layer, []);
      layers.get(c.layer).push(c);
    }
    const ordered = [...layers.entries()].sort((a, b) => a[0] - b[0]);
    return h('div.decisions-chain', ordered.map(([layer, rows]) => h('div.decisions-chain-layer', [
      h('div.layer-head', { text: `LAYER ${layer}` }),
      ...rows.map((c) => chainRow(app, c, byRef)),
    ])));
  }

  function chainRow(app, c, byRef) {
    const colour = stateColour(byRef.get(c.ref) || c);
    return h('div.decisions-chain-row', [
      h('span.dot', { style: { background: colour } }),
      h('button.decisions-chain-link', { onclick: () => app.setParam('decision', c.ref), text: `${c.ref} — ${c.title}` }),
      c.dependsOn && c.dependsOn.length ? h('span.waits', { text: `waits on ${c.dependsOn.join(', ')}` }) : null,
    ]);
  }

  /**
   * settled -> ok. superseded -> dimmed. open -> rust only while it is
   * blocking live work (`blocksCount > 0`); an open decision blocking nothing
   * is amber, because open on its own is not the reserved condition.
   *
   * `d` may be a full scoped-list row (has `blocksCount`) or a gate/chain
   * entry that only carries `state` — the caller resolves against `byRef`
   * first, so this only falls back to "no count known" for a decision outside
   * the current scope, and an open one then reads amber rather than claiming
   * a block it cannot see.
   */
  function stateColour(d) {
    if (d.state === 'settled') return 'var(--ok)';
    if (d.state === 'superseded') return 'var(--ink-6)';
    return d.blocksCount ? 'var(--blocked)' : 'var(--accent)';
  }

  // Exported because `#/map` draws the same decisions in a picture. Two copies
  // of this rule is two answers to what colour an open decision is, and the two
  // screens would eventually disagree in front of the same person.
  global.decisionColour = stateColour;
}(window));
