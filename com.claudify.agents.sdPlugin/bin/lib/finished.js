/**
 * Spotting the moment an agent finishes.
 *
 * A poll only ever says what is true *now*, so finishing is not something a
 * single reading can report -- it is a change between two of them. This keeps
 * the last reading's state per session and answers how many of them just
 * reached a good end:
 *
 *   working -> idle   a session that was busy has stopped being busy: an
 *                     interactive turn that came to an end, or a background
 *                     agent that ran out of work.
 *   * -> done         a background job's state file says it concluded, and
 *                     concluded successfully; see summarize()'s `finished`.
 *
 * Everything else is deliberately not a finish. `blocked -> idle` is an agent
 * that stopped waiting on you, not one that got anywhere; a session that simply
 * vanished between readings (its terminal closed, WSL went away) never said how
 * it ended, and guessing "success" there would celebrate a killed agent.
 */
export class FinishWatcher {
  /** @type {Map<string, string> | null} null until the first reading lands. */
  #states = null;

  /**
   * Take a reading, and report how many agents finished since the previous one.
   *
   * A failed probe is not a reading: it says nothing about the agents, so it
   * leaves the previous states in place rather than looking like everything
   * ended at once. The first reading only ever seeds -- a plugin starting up
   * next to a pile of already-finished jobs should not throw a party for them.
   */
  observe(summary) {
    if (!summary?.ok) return 0;

    const next = new Map();
    for (const agent of summary.agents ?? []) {
      if (agent.sessionId) next.set(agent.sessionId, agent.state);
    }
    for (const sessionId of summary.finished ?? []) next.set(sessionId, 'done');

    const previous = this.#states;
    this.#states = next;
    if (!previous) return 0;

    let finished = 0;
    for (const [sessionId, state] of next) {
      const before = previous.get(sessionId);
      // A session first seen in this reading has no "before" to have finished
      // from; unchanged state is, by definition, not a change.
      if (before === undefined || before === state) continue;
      if (state === 'done' || (state === 'idle' && before === 'working')) finished += 1;
    }
    return finished;
  }
}
