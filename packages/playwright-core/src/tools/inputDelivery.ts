/**
 * An input (click, key press) that reached a page whose main thread is busy
 * is not acknowledged until that thread is free again. These helpers tell that
 * case apart from an input that never reached the page.
 */

// Last call-log line of a pointer action that timed out after its events were written to the page.
const SENT_POINTER_LOG_LINES = new Set([
  'performing click action',
  'performing dblclick action',
  'click action done',
  'dblclick action done',
  'waiting for scheduled navigations to finish',
]);

const ANSI_CODES = /\u001b\[[0-9;]*m/g;

export class InputUnacknowledgedError extends Error {
  constructor(waitedMs: number) {
    super(`Input sent, not acknowledged within ${waitedMs}ms`);
    this.name = 'InputUnacknowledgedError';
  }
}

/**
 * Settles with the send when it settles first. Otherwise rejects once the
 * time is up; the send keeps running and finishes when the page answers.
 * No time given means no race.
 */
export async function raceAcknowledgement<T>(send: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  const sent = send();
  if (timeoutMs === undefined)
    return await sent;
  sent.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new InputUnacknowledgedError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([sent, timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

export function isUnacknowledgedInput(error: unknown): boolean {
  if (error instanceof InputUnacknowledgedError)
    return true;
  if (!(error instanceof Error) || error.name !== 'TimeoutError')
    return false;
  const logLines = error.message.replace(ANSI_CODES, '').split('\n')
      .map(line => line.trim().replace(/^- /, ''))
      .filter(Boolean);
  return SENT_POINTER_LOG_LINES.has(logLines[logLines.length - 1]);
}

export function inputSentNote(waitedMs: number): string {
  return `Input sent, but the page did not acknowledge it within ${waitedMs}ms. The page may still be processing it: check the page before repeating the action.`;
}
