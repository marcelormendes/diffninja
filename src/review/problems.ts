/**
 * Refusals that name every problem at once. The agent's reading is checked
 * whole before anything is kept, and a refusal that named only the first
 * problem would cost a round trip per mistake, so each check adds what it finds
 * to one list and the call is refused with all of it.
 */

/** Most problems one refusal lists; the rest are counted. */
export const MAX_LISTED_PROBLEMS = 10;

/** Thrown for a refused call: one error that carries every problem found. */
export class ProblemsError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problemsMessage(problems));
    this.name = "ProblemsError";
  }
}

/** One problem reads as it always has; several become a short numbered list. */
export function problemsMessage(problems: readonly string[]): string {
  if (problems.length === 1) return problems[0];
  const listed = problems.slice(0, MAX_LISTED_PROBLEMS).map((text, index) => `${index + 1}. ${text}`);
  const more = problems.length - listed.length;
  if (more > 0) listed.push(`… and ${more} more; fix these and call again to see them.`);
  return [`${problems.length} problems; nothing was kept. Fix them all and call again:`, ...listed].join("\n");
}

/** One problem, thrown by a check that stops at it; {@link collectProblem} keeps it and goes on. */
export function problem(message: string): ProblemsError {
  return new ProblemsError([message]);
}

/** Refuse the call when any problem was found. */
export function refuseProblems(problems: readonly string[]): void {
  if (problems.length > 0) throw new ProblemsError(problems);
}

/**
 * Run one check that stops at its first problem, keeping what it found and
 * going on. Any error other than a {@link ProblemsError} is a fault in
 * diffninja, not in the call, and is thrown on.
 */
export function collectProblem(problems: string[], check: () => void): void {
  try {
    check();
  } catch (error) {
    if (!(error instanceof ProblemsError)) throw error;
    problems.push(...error.problems);
  }
}
