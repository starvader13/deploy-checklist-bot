// In-memory map of active debounce timers, keyed by "owner/repo#pr" string
const pending = new Map<string, NodeJS.Timeout>();

/**
 * Debounce analysis for a specific PR.
 * If a new event arrives before the delay expires, the previous one is cancelled.
 */
export function debouncePR(
  key: string,
  delayMs: number,
  callback: () => Promise<void>
): void {
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(async () => {
    pending.delete(key);
    await callback();
  }, delayMs);

  pending.set(key, timeout);
}

export function cancelPending(key: string): void {
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing);
    pending.delete(key);
  }
}

export function hasPending(key: string): boolean {
  return pending.has(key);
}

export function debounceKey(
  owner: string,
  repo: string,
  prNumber: number
): string {
  return `${owner}/${repo}#${prNumber}`;
}
