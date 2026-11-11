// Single-process extension seam. Only the active dispatch Host can bind it.
// Native Connection supplies authenticated peers; the bound Host verifies owner,
// controller identity, workspace, then reuses the same Dispatcher/journal/locks.
let active;
export function bindDispatchUi(api) {
  if (active) throw new Error('Dispatch UI bridge already bound');
  active = Object.freeze(api);
  return () => { if (active === api || active?.instanceId === api.instanceId) active = undefined; };
}
export function getDispatchUi() {
  if (!active) { const error = new Error('调度服务暂不可用，请稍后重试；未派发任务'); error.code = 'DISPATCH_UNAVAILABLE'; throw error; }
  return active;
}
