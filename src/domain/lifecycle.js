/**
 * The project life cycle: phases, gates, and the one rule that makes them mean
 * something.
 *
 * A project cannot leave a phase until its gate criterion is recorded as met.
 * "Recorded" is a date and a person, not a flag — a boolean gate tells you it
 * was signed and nothing about when or by whom, and that is exactly the question
 * asked six months later when the criterion turns out not to have held.
 *
 * `blocked` is the only state allowed to draw in the reserved colour, and it
 * means the criterion is itself an open decision. It does not mean the work is
 * late. Late work is a schedule fact and shows up on the Gantt.
 */

'use strict';

const STATES = ['not_entered', 'current', 'gate_met', 'blocked'];

/**
 * Can this project advance out of `phase`?
 *
 * Returns { ok, reason }. The reason is written to be shown to a person, because
 * a refusal with no reason is a refusal somebody works around.
 */
function canAdvance(phase, { openDecisions = 0, openImmediateBugs = 0 } = {}) {
  if (!phase) return { ok: false, reason: 'there is no current phase to leave' };
  if (phase.state === 'gate_met') return { ok: false, reason: `${phase.gate_name} is already met` };
  if (phase.state === 'blocked') {
    return { ok: false, reason: `${phase.gate_name}'s criterion is itself an open decision` };
  }
  if (openDecisions > 0) {
    return { ok: false, reason: `${openDecisions} decision(s) this phase waits on are still open` };
  }
  // Read from the criterion rather than hard-coded: a phase whose criterion
  // mentions immediate bugs is checked against them, and one that does not is
  // not. Hard-coding it would apply a software project's gate to a manuscript.
  if (/immediate/i.test(phase.gate_criterion || '') && openImmediateBugs > 0) {
    return { ok: false, reason: `${openImmediateBugs} immediate-priority bug(s) are open` };
  }
  return { ok: true, reason: null };
}

/**
 * Roll a project's phases up for display: which is current, which gate is next,
 * and how far through the life cycle it is.
 *
 * `progress` is phases completed over phases total — a coarse figure, and
 * labelled as such wherever it is shown, because six phases cannot express
 * eighty per cent of anything.
 */
function summarise(phases) {
  const ordered = [...phases].sort((a, b) => a.position - b.position);
  const current = ordered.find((p) => p.state === 'current' || p.state === 'blocked') || null;
  const met = ordered.filter((p) => p.state === 'gate_met');
  const shipped = ordered.length > 0 && met.length === ordered.length;
  const nextGate = current
    ? {
      gate: current.gate_name,
      phase: current.name,
      criterion: current.gate_criterion,
      blocked: current.state === 'blocked',
    }
    : shipped
      ? { gate: null, phase: 'Shipped', criterion: null, blocked: false }
      : null;
  return {
    phases: ordered,
    current,
    currentIndex: current ? ordered.indexOf(current) : (shipped ? ordered.length : 0),
    gatesMet: met.length,
    gatesTotal: ordered.length,
    progress: ordered.length ? Math.round((met.length / ordered.length) * 100) : 0,
    nextGate,
    blocked: Boolean(current && current.state === 'blocked'),
    shipped,
  };
}

/**
 * The phase rows to write when a gate is signed: the signed phase becomes
 * gate_met, and the next one becomes current. Returns the updates rather than
 * applying them, so the caller can do it in one transaction with the activity
 * entry.
 */
function signGate(phases, phaseId, { on, by }) {
  const ordered = [...phases].sort((a, b) => a.position - b.position);
  const i = ordered.findIndex((p) => Number(p.id) === Number(phaseId));
  if (i < 0) throw new Error(`phase ${phaseId} is not in this project`);
  const updates = [{ id: ordered[i].id, state: 'gate_met', gate_met_on: on, gate_met_by: by }];
  if (ordered[i + 1] && ordered[i + 1].state === 'not_entered') {
    updates.push({ id: ordered[i + 1].id, state: 'current' });
  }
  return updates;
}

module.exports = { STATES, canAdvance, summarise, signGate };
