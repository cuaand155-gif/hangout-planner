// When to refresh a saved calendar, and whether a refresh changed anything.

export const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;

/** A source is due when it has never synced, or its last sync is old enough. */
export function dueForSync(lastSyncedAt, now = new Date(), intervalMs = AUTO_SYNC_INTERVAL_MS) {
  if (!lastSyncedAt) return true;
  const last = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(last)) return true;
  return new Date(now).getTime() - last >= intervalMs;
}

function key(block) {
  return `${new Date(block.start).toISOString()}|${new Date(block.end).toISOString()}|${block.title || ""}|${block.location || ""}|${block.source || ""}`;
}

/**
 * True when two busy lists hold the same blocks, in any order. Used to skip
 * saving a refresh that found nothing new, so an idle sync never touches the
 * shared workspace or its activity feed.
 */
export function sameBusy(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}
