// Local, server-only Cordis entry. Node built-ins only: no package installation or client build.
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { bindDispatchUi } from './ui-bridge.mjs';
import { checkConfig, CONTROLLER, Dispatcher, Journal, PROBE_ORDER, probeId, requireCondition, sameDirectory, TARGETS, terminal, WORKSPACE } from './core-v3.mjs?v=0.3.0';

export const name = 'douyin-approved-session-dispatch';
export const inject = ['tools', 'agents', 'sessionController', 'typertGateway', 'connection', 'remoteAccess', 'workingDirectory'];
const KIND = 'douyin-approved-session-dispatch';
const string = { type: 'string' };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const output = { schema: string, render: (_args, value) => [{ type: 'text', text: value }] };

export async function apply(ctx) {
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
  requireCondition(sameDirectory(root), 'Plugin must be located inside the approved workspace');
  const config = checkConfig(JSON.parse(await readFile(path.join(root, 'config', 'session-dispatch-v3.json'), 'utf8')));
  const journal = new Journal(path.join(root, 'control', 'session-dispatch', 'tasks'));
  await journal.init();
  requireCondition(sameDirectory(journal.directory, path.join(root, 'control', 'session-dispatch', 'tasks')), 'Journal directory must not redirect outside its approved location');
  const instanceId = randomUUID();
  const admissions = new Set(); const callbacks = new Set(); const registered = new WeakSet(); const registeredIds = new Set();
  const errors = []; const lifecycle = new AbortController();
  const principal = Object.freeze({ kind: KIND, controller_session_id: CONTROLLER, workspace: WORKSPACE, instance_id: instanceId });
  const authorizedPrincipal = (p) => p?.kind === KIND && p.controller_session_id === CONTROLLER && p.workspace === WORKSPACE && p.instance_id === instanceId;
  const targetRole = { name: 'douyin-approved-dispatch-target', resource: 'session', actions: ['session/projections', 'session/prompt'] };
  const controllerRole = { name: 'douyin-dispatch-receipt-only', resource: 'session', actions: ['session/prompt'] };
  ctx.remoteAccess.registerPolicy(KIND, {
    bindings(p) {
      if (!authorizedPrincipal(p) || lifecycle.signal.aborted) return [];
      return [...Object.values(TARGETS).map((target) => ({ role: targetRole, resource: { kind: 'session', id: target.id },
        condition({ action, args }) {
          if (action === 'session/projections') return { kind: 'allow' };
          const request = args?.request;
          const live = ctx.agents.get(target.id);
          const allowed = request?.mode === 'queue' && admissions.has(request.requestId) && request.sessionId === target.id
            && live?.session?.id === target.id && sameDirectory(ctx.workingDirectory.get(live.session));
          return allowed ? { kind: 'allow' } : { kind: 'deny', reason: 'dispatch-admission-not-authorized' };
        } })),
        { role: controllerRole, resource: { kind: 'session', id: CONTROLLER }, condition({ args }) {
          const request = args?.request; const live = ctx.agents.get(CONTROLLER);
          const allowed = request?.mode === 'queue' && callbacks.has(request.requestId) && request.sessionId === CONTROLLER
            && live?.session?.id === CONTROLLER && sameDirectory(ctx.workingDirectory.get(live.session));
          return allowed ? { kind: 'allow' } : { kind: 'deny', reason: 'receipt-not-authorized' };
        } }];
    },
  });
  // A scoped in-process non-owner Peer is the normal Host extension contract. No cookie/token
  // is read and no owner Peer is fabricated. Gateway still evaluates resource/action policy.
  const peer = ctx.connection.createPeer({ principal, interactions: 'none' });
  const invoke = (method, request, signal = lifecycle.signal) => ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, signal, peer });
  const actualDirectory = async (agent) => {
    requireCondition(agent?.session && agent.id === agent.session.id, 'An original ordinary Agent is required');
    return realpath(ctx.workingDirectory.get(agent.session));
  };
  const adapter = {
    async businessApproved(role) {
      const latest = checkConfig(JSON.parse(await readFile(path.join(root, 'config', 'session-dispatch-v3.json'), 'utf8')));
      return latest.targets[role]?.verified === true;
    },
    async callerDirectory(caller) { requireCondition(caller.id === caller.agent?.session?.id, 'Caller identity mismatch'); return actualDirectory(caller.agent); },
    async inspect(id, signal) {
      requireCondition(Object.values(TARGETS).some((target) => target.id === id), 'Unapproved inspect target');
      const result = await invoke('projections', { sessionId: id }, signal);
      if (!result || result.kind !== 'sequenced') return null;
      const directory = result.values?.workingDirectory;
      return { cwd: typeof directory === 'string' ? await realpath(directory) : null, live: ctx.agents.get(id) !== undefined };
    },
    async prepare(id, signal) {
      signal?.throwIfAborted(); lifecycle.signal.throwIfAborted();
      requireCondition(Object.values(TARGETS).some((target) => target.id === id), 'Unapproved restore target');
      const result = await ctx.sessionController.resolveAgent(id);
      if ('error' in result) throw result.error;
      requireCondition(result.agent.session.id === id && sameDirectory(await actualDirectory(result.agent)), 'Restored identity/workspace mismatch');
      signal?.throwIfAborted(); lifecycle.signal.throwIfAborted();
    },
    async prompt(id, requestId, message, signal) {
      lifecycle.signal.throwIfAborted();
      requireCondition(Object.values(TARGETS).some((target) => target.id === id), 'Unapproved prompt target');
      admissions.add(requestId);
      try { return await invoke('prompt', { sessionId: id, requestId, mode: 'queue', content: [{ type: 'text', text: message }] }, signal); }
      finally { admissions.delete(requestId); }
    },
    async notificationAccepted(requestId) {
      const controller = ctx.agents.get(CONTROLLER);
      if (!controller || !sameDirectory(await actualDirectory(controller))) return false;
      const matches = (source) => source?.kind === 'user' && source.rpcId === requestId && source.principal?.kind === KIND;
      // Inspect only this controller's exact receipt source IDs, never message content or
      // another chat's history/storage. Same test as the native prompt idempotency helper.
      return controller.inbox.nextTurn.some((message) => matches(message.source))
        || controller.inbox.nextStep.some((message) => matches(message.source))
        || controller.session.snapshotEvents().some((event) => event.type === 'user/message' && matches(event.data.source));
    },
    notificationError(taskId, error) { return noteError(new Error(`Notification task=${taskId}; code=${error.code ?? 'unknown'}; ${error.message ?? error}`)); },
    async notify(requestId, message, signal) {
      lifecycle.signal.throwIfAborted();
      const controller = ctx.agents.get(CONTROLLER);
      requireCondition(controller && sameDirectory(await actualDirectory(controller)), 'Original controller is not attached in the same workspace; receipt retained on disk');
      callbacks.add(requestId);
      try { return await invoke('prompt', { sessionId: CONTROLLER, requestId, mode: 'queue', content: [{ type: 'text', text: message }] }, signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal); }
      finally { callbacks.delete(requestId); }
    },
  };
  const dispatcher = new Dispatcher({ journal, adapter });
  const uiCaller = async (browserPeer, sessionId, signal) => {
    requireCondition(browserPeer?.principal?.kind === 'owner', 'Authenticated owner browser required');
    requireCondition(sessionId === CONTROLLER, 'Dashboard is restricted to the approved controller');
    const agent = ctx.agents.get(CONTROLLER);
    requireCondition(agent && sameDirectory(await actualDirectory(agent)), 'Controller workspace mismatch');
    return { id: CONTROLLER, agent, signal: signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal };
  };
  ctx.effect(() => bindDispatchUi({
    instanceId,
    async send(browserPeer, sessionId, args, signal) {
      return dispatcher.send(await uiCaller(browserPeer, sessionId, signal), args, 'user-sidebar-click');
    },
    async status(browserPeer, sessionId, taskId, signal) {
      return dispatcher.status(await uiCaller(browserPeer, sessionId, signal), taskId);
    },
    async records(browserPeer, sessionId, signal) {
      await uiCaller(browserPeer, sessionId, signal);
      return (await journal.records()).filter((record) => Object.values(TARGETS).some((target) => target.id === record.target_session_id));
    },
  }));
  const callerOf = (exec) => {
    requireCondition(exec?.agent?.session?.id && exec.agent.id === exec.agent.session.id, 'Requires a genuine owning Agent');
    return { id: exec.agent.session.id, agent: exec.agent, signal: exec.signal };
  };
  const hostDirectory = path.join(root, 'control', 'session-dispatch', 'hosts');
  await mkdir(hostDirectory, { recursive: true });
  requireCondition(sameDirectory(await realpath(hostDirectory), hostDirectory), 'Host status directory must not redirect outside its approved location');
  const hostFile = path.join(hostDirectory, `host-${process.pid}.json`);
  const loadedAt = new Date().toISOString();
  let disposed = false; let bootstrapPending = Promise.resolve();
  const saveHost = () => writeFile(hostFile, JSON.stringify({ schema_version: 1, plugin_version: '0.4.0', ui_bridge: true,
    pid: process.pid, instance_id: instanceId, loaded_at: loadedAt, updated_at: new Date().toISOString(),
    state: disposed ? 'disposed' : 'loaded', workspace: root, controller_session_id: CONTROLLER,
    controller_attached: ctx.agents.get(CONTROLLER) !== undefined,
    target_attached: Object.fromEntries(Object.entries(TARGETS).map(([key, target]) => [key, ctx.agents.get(target.id) !== undefined])),
    registered_tool_sessions: [...registeredIds], errors }, null, 2) + '\n');
  const noteError = async (error) => {
    // Final error sink must never reject: filesystem/logging can fail together on Windows.
    try {
      const detail = String(error.message ?? error).slice(0, 1200);
      errors.push(detail); if (errors.length > 10) errors.shift();
      try { ctx.logger?.warn?.(`session-dispatch: ${detail}`); } catch {}
      try { await saveHost(); }
      catch (sinkError) { try { console.error('session-dispatch: Host error log unavailable', String(sinkError.message ?? sinkError)); } catch {} }
    } catch { try { console.error('session-dispatch: error reporting unavailable'); } catch {} }
  };
  const bootstrap = () => {
    bootstrapPending = bootstrapPending.catch(() => {}).then(async () => {
      if (disposed || config.startup_probe !== true) return;
      const agent = ctx.agents.get(CONTROLLER);
      if (!agent) return;
      const caller = { id: agent.session.id, agent, signal: lifecycle.signal };
      for (const record of await journal.records()) {
        if (terminal(record.status) && record.notification !== 'accepted' && await adapter.notificationAccepted(`douyin-dispatch-report:${record.task_id}`)) {
          await dispatcher.notify(record.task_id).catch((error) => adapter.notificationError(record.task_id, error));
        }
      }
      for (const role of PROBE_ORDER) {
        const record = await dispatcher.status(caller, probeId(role));
        if (record?.status === 'completed') continue;
        if (record) return; // Do not automatically retry uncertain/failed admissions.
        const result = await dispatcher.send(caller, { target: role, task_id: probeId(role), kind: 'probe' }, 'user-authorized-startup-probe');
        requireCondition(result.status === 'accepted', `Probe not confirmed accepted: ${result.error ?? result.status}`);
        await saveHost(); return; // Next target starts only after this target's completed receipt.
      }
      await saveHost();
    });
    return bootstrapPending;
  };
  function tool(toolName, description, parameters, execute) {
    // Raw ToolDefinition: strict argument checks are implemented in core/execute, not assumed
    // from model-facing JSON Schema. Registry validates the returned string schema.
    return { name: toolName, description, parameters, output, timeoutMs: 60000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        try { return JSON.stringify(await execute(args, callerOf(exec)), null, 2); }
        catch (error) { await noteError(error); throw error; }
      } };
  }
  function attach(agent) {
    if (disposed || registered.has(agent)) return;
    const id = agent?.session?.id;
    if (id !== CONTROLLER && !Object.values(TARGETS).some((target) => target.id === id)) return;
    registered.add(agent); registeredIds.add(id);
    const definitions = id === CONTROLLER ? [
      tool('session_dispatch_send', 'Send an authorized queued task only to one of five existing approved chats. Never create/fork/broadcast/steer. Use a unique stable task_id; business tasks require that target to have passed the live probe. accepted is not completed.',
        schema({ target: { type: 'string', enum: Object.keys(TARGETS) }, task_id: string, kind: { type: 'string', enum: ['probe', 'role_check', 'task'] }, instruction: string }, ['target', 'task_id']),
        (args, caller) => dispatcher.send(caller, args)),
      tool('session_dispatch_status', 'Read the local audited status/receipt of a known dispatch task, without scanning other chats or running models.',
        schema({ task_id: string }, ['task_id']), (args, caller) => {
          requireCondition(args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 1 && Object.hasOwn(args, 'task_id'), 'Expected only task_id');
          return dispatcher.status(caller, args.task_id);
        }),
    ] : [
      tool('session_dispatch_report', 'Report started/completed/blocked/failed only for a task addressed to this exact existing chat. Report your actual approved role and workspace-relative outputs. A final receipt is immutable and notifies the controller once; do not start more work.',
        schema({ task_id: string, status: { type: 'string', enum: ['started', 'completed', 'blocked', 'failed'] }, role: { type: 'string', description: 'Actual business role, distinct from technical Team Lead. completed requires the approved role; blocked/failed may report an actual conflicting role.' }, summary: string, outputs: { type: 'array', items: string, maxItems: 20 } }, ['task_id', 'status', 'role', 'summary']),
        async (args, caller) => {
          const record = await dispatcher.report(caller, args);
          if (terminal(record.status)) queueMicrotask(() => { bootstrap().catch(noteError); });
          return record;
        }),
    ];
    ctx.effect(() => {
      const disposers = definitions.map((definition) => agent.ctx.tools.register(definition));
      return () => { for (const dispose of disposers.reverse()) dispose(); registeredIds.delete(id); };
    });
  }
  ctx.on('agent/created', ({ agent }) => {
    attach(agent);
    saveHost().catch(noteError);
    if (agent.session.id === CONTROLLER) bootstrap().catch(noteError);
  });
  ctx.effect(() => async () => {
    disposed = true; lifecycle.abort(new Error('Session dispatch plugin unloaded'));
    await peer.dispose(); await saveHost();
  });
  // Only six explicitly known IDs (controller + five targets) are looked up; never enumerate session storage or histories.
  for (const id of [CONTROLLER, ...Object.values(TARGETS).map((target) => target.id)]) {
    const agent = ctx.agents.get(id); if (agent) attach(agent);
  }
  await saveHost();
  // Background initialization is explicitly restricted to the fixed, user-authorized probes.
  // Persistent task IDs prevent reloads from creating duplicate probe messages.
  bootstrap().catch(noteError);
}
