/**
 * Per-call state for one tool call: identity for telemetry and the deadline.
 * Carried by the async context, so overlapping calls and work that outlives
 * its call each keep their own.
 */

import { AsyncLocalStorage } from 'async_hooks';

import { monotonicTime } from '../utils/isomorphic/time';

export type RequestScope = {
  callId: string;
  tool: string;
  sessionId?: string;
  // Monotonic milliseconds: a wall-clock step (NTP correction) must not move a call's deadline.
  deadline: number;
};

export class RequestDeadlineError extends Error {
  constructor(scope: RequestScope) {
    super(`Deadline of tool "${scope.tool}" has passed`);
    this.name = 'RequestDeadlineError';
  }
}

const storage = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * For resources that outlive the call creating them (sockets, browser
 * connections): their callbacks would otherwise keep that call's scope.
 */
export function runOutsideRequestScope<T>(fn: () => T): T {
  return storage.exit(fn);
}

export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore();
}

/** Milliseconds left for the current call; unbounded when no call is running. */
export function remainingRequestBudget(): number {
  const scope = storage.getStore();
  if (!scope)
    return Infinity;
  const remaining = scope.deadline - monotonicTime();
  if (remaining <= 0)
    throw new RequestDeadlineError(scope);
  return remaining;
}
