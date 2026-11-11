// One existing Loader row owns both server halves and exposes this package's
// prebuilt client bundle. This avoids a second server and preserves the native
// dispatcher's exact five-session admission/journal semantics.
import { apply as applyDispatch } from '../session-dispatch/host-v4.mjs?v=0.4.5';
import { apply as applyDashboard } from './host.mjs?v=1.0.6';

export const name = 'douyin-approved-session-dispatch-dashboard';
export const inject = ['tools', 'agents', 'sessionController', 'typertGateway', 'connection', 'webServer', 'remoteAccess', 'workingDirectory'];
export async function apply(ctx) {
  await applyDispatch(ctx);
  await applyDashboard(ctx);
}
