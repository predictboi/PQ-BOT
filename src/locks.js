// Per-key async mutex so the volume trader and the odds sync never sign two transactions from the same wallet at once.
const chains = new Map();
export function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => {}); // the caller handles next's rejection
  return next;
}
