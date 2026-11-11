import path from 'node:path';
import { lstat, realpath, readdir, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Journal, CONTROLLER, TARGETS, terminal } from '../session-dispatch/core-v3.mjs?v=0.3.0';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const UPDATE_KEYS = new Set(['session1', 'session2', 'session4', 'session5']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exactUuid = value => typeof value === 'string' && value.length === 36 && !/[\r\n\0]/.test(value) && UUID.test(value);
const exactVideoId = value => typeof value === 'string' && value.length >= 10 && value.length <= 24 && !/[\r\n\0]/.test(value) && /^\d+$/.test(value);
export function assertOwner(peer, sessionId) {
  if (peer?.principal?.kind !== 'owner' || sessionId !== CONTROLLER) {
    const error = new Error('仅当前总管对话的已认证用户可使用业务工作台'); error.code = 'FORBIDDEN'; throw error;
  }
}
function need(value, message, code = 'BAD_REQUEST') {
  if (!value) { const error = new Error(message); error.code = code; throw error; }
}
export async function safePath(root, relative, { createDirectory = false } = {}) {
  const base = await realpath(root), target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  need(rel && !rel.startsWith('..') && !path.isAbsolute(rel), '路径超出工作区');
  let current = base;
  for (const piece of rel.split(path.sep)) {
    current = path.join(current, piece);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!createDirectory) throw error;
      await mkdir(current); stat = await lstat(current);
    }
    need(!stat.isSymbolicLink(), '不接受重定向路径');
    const resolved = await realpath(current);
    need(resolved === current, '路径实际位置不匹配');
  }
  return target;
}
async function boundedRead(root, relative, limit = 2 * 1024 * 1024) {
  const p = await safePath(root, relative), stat = await lstat(p);
  need(stat.isFile() && stat.size <= limit, '文件类型或大小不合法');
  return readFile(p);
}

// Validate the sealed management handoff without executing scripts or scanning chats.
export async function findReadyHandoff(root, videoId) {
  let base;
  try { base = await safePath(root, 'handoffs'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const dirs = (await readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && !d.isSymbolicLink());
  need(dirs.length <= 300, '交接目录过多，需要管理归档');
  for (const entry of dirs.reverse()) {
    const relative = path.posix.join('handoffs', entry.name);
    try {
      const handoffBytes = await boundedRead(root, `${relative}/handoff.json`);
      const h = JSON.parse(handoffBytes);
      const selection = h.payload?.selection;
      if (h.schema_version !== 2 || selection?.schema_version !== 2 || selection?.scope !== 'selected_reference_only' || JSON.stringify(selection?.video_ids) !== JSON.stringify([videoId])) continue;
      need(/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(selection.batch_id), '批次ID不合法');
      need(typeof selection.user_request === 'string' && selection.user_request.trim() && typeof selection.user_choice === 'string' && selection.user_choice.trim(), '缺少用户选片与创作确认');
      const inputs = h.inputs;
      need(inputs && Object.keys(inputs).sort().join() === 'business,request,review,source', '交接输入声明不完整');
      for (const value of Object.values(inputs)) need(typeof value === 'string' && value && !path.isAbsolute(value) && !value.split(/[\\/]/).includes('..'), '交接输入路径不合法');
      const selectionBytes = await boundedRead(root, `${relative}/selection.json`);
      const seal = JSON.parse(await boundedRead(root, `${relative}/seal.json`));
      need(sha(handoffBytes) === seal.handoff_sha256 && sha(selectionBytes) === seal.selection_sha256, '交接哈希变化');
      need(JSON.stringify(JSON.parse(selectionBytes)) === JSON.stringify(selection), '选片与交接不一致');
      const review = h.payload.manager_review, ref = h.payload.reference;
      need(review?.approved_for_original_reference === true && review.reviewed_by === 'controller' && review.video_id === videoId && review.batch_id === selection.batch_id, '尚未总管验收');
      need(ref?.mapping?.video_id === videoId && ref?.mapping?.url === `https://www.douyin.com/video/${videoId}` && ref?.verification?.sufficient_for_original_reference === true, '参考身份或核验状态不一致');
      need(Array.isArray(review.limitations) && review.limitations.length && Array.isArray(review.excluded_material) && review.excluded_material.length, '事实边界不足');
      need(ref.fact_boundary && typeof ref.fact_boundary === 'object' && Object.keys(ref.fact_boundary).length && Array.isArray(ref.transferable_mechanisms) && ref.transferable_mechanisms.length && Array.isArray(ref.do_not_copy) && ref.do_not_copy.length && Array.isArray(ref.verified_problem) && ref.verified_problem.length && Array.isArray(ref.verified_solution_points) && ref.verified_solution_points.length, '参考事实边界不完整');
      const manifestObject = h.payload.manifest;
      need(manifestObject && typeof manifestObject === 'object' && !Array.isArray(manifestObject), '交接证据清单不合法');
      const manifest = Object.entries(manifestObject);
      need(manifest.length >= 8 && manifest.length <= 160, '交接证据清单不完整');
      const source = inputs.source.replaceAll('\\', '/').replace(/\/$/, '');
      const required = [inputs.request, inputs.review, inputs.business, `${source}/handoff-input.json`, `${source}/deep-check.json`, `${source}/evidence.json`, `${source}/card.md`, `batches/${selection.batch_id}/batch.json`].map(v => v.replaceAll('\\', '/'));
      for (const file of required) need(Object.hasOwn(manifestObject, file), `交接缺少必需来源：${file}`);
      for (const [file, hash] of manifest) {
        need(typeof file === 'string' && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash), '交接证据条目不合法');
        need(sha(await boundedRead(root, file, 16 * 1024 * 1024)) === hash, '源材料变化，需重新验收');
      }
      // Re-read the identity-bearing sources rather than trusting only the frozen summary.
      const request = JSON.parse(await boundedRead(root, inputs.request));
      const sourceInput = JSON.parse(await boundedRead(root, `${source}/handoff-input.json`));
      const deepCheck = JSON.parse(await boundedRead(root, `${source}/deep-check.json`));
      const evidence = JSON.parse(await boundedRead(root, `${source}/evidence.json`));
      const sourceReview = JSON.parse(await boundedRead(root, inputs.review));
      const sourceBusiness = JSON.parse(await boundedRead(root, inputs.business));
      const batch = JSON.parse(await boundedRead(root, `batches/${selection.batch_id}/batch.json`, 4 * 1024 * 1024));
      need(selection.confirmation_record?.replaceAll('\\', '/') === inputs.request.replaceAll('\\', '/'), '确认记录路径不一致');
      need(request.video_id === videoId && request.batch_id === selection.batch_id && request.user_request === selection.user_request && request.user_choice === selection.user_choice, '用户确认来源不一致');
      need(JSON.stringify(sourceReview) === JSON.stringify(review) && JSON.stringify(sourceBusiness) === JSON.stringify(h.payload.business_profile), '管理验收或业务档案来源变化');
      need(sourceInput.user_selected_video_id === videoId && sourceInput.source_batch_id === selection.batch_id && sourceInput.verification?.sufficient_for_original_reference === true, '生产交接输入不一致');
      const expectedReference = Object.fromEntries(['verification','verified_problem','verified_solution_points','comment_needs','transferable_mechanisms','do_not_copy','fact_boundary'].map(key => [key, sourceInput[key]]));
      expectedReference.mapping = evidence.mapping;
      need(JSON.stringify(expectedReference) === JSON.stringify(ref), '冻结参考摘要与源材料不一致');
      const checks = deepCheck.checks;
      need(checks && typeof checks === 'object' && !Array.isArray(checks) && Object.keys(checks).length > 0 && Object.values(checks).every(value => value === true), '生产自查未通过');
      need(deepCheck.video_id === videoId && deepCheck.passed === true && deepCheck.assessment?.structure_content_verified_enough_for_original === true, '生产自查身份或结论不一致');
      need(evidence.source_batch_id === selection.batch_id && evidence.mapping?.video_id === videoId && evidence.mapping?.url === `https://www.douyin.com/video/${videoId}`, '证据身份不一致');
      const comments = sourceInput.comment_needs;
      need(Number.isInteger(comments?.sample_size) && comments.sample_size >= 30 && Number.isInteger(comments.low_information) && comments.low_information >= 0 && comments.low_information <= comments.sample_size / 2 && comments.sampled_at && Array.isArray(comments.excerpts) && comments.excerpts.length, '评论样本不满足交接门槛');
      need(evidence.mapping.category === 'benchmark' || evidence.mapping.category === 'home', '当前单条交接仅支持对标/家居参考');
      const published = Date.parse(evidence.mapping.published_at);
      const windowStart = Date.parse(`${batch.window_start}T00:00:00+08:00`), windowEnd = Date.parse(batch.window_end);
      need(Number.isFinite(published) && Number.isFinite(windowStart) && Number.isFinite(windowEnd) && published >= windowStart && published <= windowEnd, '参考不在冻结时间窗');
      if (evidence.mapping.category === 'benchmark') need(Array.isArray(batch.confirmed_benchmarks) && batch.confirmed_benchmarks.some(item => item.account_id === evidence.mapping.account_id && item.status === 'confirmed'), '对标账号未确认');
      const relativeFrom = (base, child) => {
        const target = path.resolve(root, base, child);
        const rel = path.relative(root, target);
        need(rel && !rel.startsWith('..') && !path.isAbsolute(rel), '证据路径越界');
        return rel.replaceAll('\\', '/');
      };
      const media = [];
      need(evidence.cover?.file && /^[0-9a-f]{64}$/.test(evidence.cover.sha256), '封面证据缺失');
      media.push([relativeFrom(`batches/${selection.batch_id}`, evidence.cover.file), evidence.cover.sha256]);
      need(Array.isArray(evidence.representative_frames) && evidence.representative_frames.length >= 3, '开头/主体/收尾代表图不足');
      for (const frame of evidence.representative_frames) media.push([relativeFrom(source, frame.file), frame.sha256]);
      const frames = evidence.dense_observation?.frames;
      need(Array.isArray(frames) && frames.length >= 3 && Number.isFinite(evidence.video?.duration_seconds), '密集观察证据不足');
      const times = frames.map(frame => frame.actual);
      need(times.every(Number.isFinite) && times.every((value, index) => index === 0 || value > times[index - 1]) && times[0] <= 2 && evidence.video.duration_seconds - 2 <= times.at(-1) && times.at(-1) <= evidence.video.duration_seconds && Math.max(...times.slice(1).map((value, index) => value - times[index])) <= 3, '视觉观察覆盖不足');
      for (const frame of frames) { need(Number.isFinite(frame.seconds) && Math.abs(frame.actual - frame.seconds) <= 0.5, '媒体时点不匹配'); media.push([relativeFrom(source, frame.path), frame.sha256]); }
      for (const [file, hash] of media) {
        need(Object.hasOwn(manifestObject, file) && manifestObject[file] === hash, `交接缺少媒体证据：${file}`);
        need(/^[0-9a-f]{64}$/.test(hash) && sha(await boundedRead(root, file, 16 * 1024 * 1024)) === hash, '媒体证据变化');
      }
      return { directory: relative, sha256: seal.handoff_sha256, batchId: selection.batch_id, videoId };
    } catch (e) {
      // A missing/stale candidate never becomes ready. Another immutable version may be valid.
      if (!['ENOENT', 'BAD_REQUEST'].includes(e.code) && !(e instanceof SyntaxError)) throw e;
    }
  }
  return null;
}

const UPDATES = {
  session1: '用户点击【对标账号-更新】。开工前先按docs/登录账号确认规则-20261111.md确认抖音登录账号为研究专用号研究小号；未登录或账号不符立即停止并回传blocked。按会话1说明更新全部已确认对标账号的相关情况：身份/定位/主页变化、近期内容与互动、运营和获客路径、可借鉴机制及证据缺口。以已有账号库和最新报告为基线，不把候选冒充已确认；未知不补造，不冒称能看私有数据。Edge只读并遵守与会话2/5互斥；先核验占用。新建research/benchmarks/独立时间戳报告和结构化快照，保留历史。',
  session2: '用户点击【参考视频-更新】。开工前先按docs/登录账号确认规则-20261111.md确认抖音登录账号为研究专用号研究小号；未登录或账号不符立即停止并回传blocked。按会话2说明、最新筛选规则及v3封面要求建立新批次，快采50候选：非家居15只取冻结近72小时，点赞优先；对标20/家居15保留六个自然月、评论优先。排除美食吃播、去重、实名来源和匿名评论证据，真实原封面；不足如实交付，不扩窗凑数、不替用户选片。Edge只读并核实共享占用。报告版式保持原样不得改版：仅顶部加总体分析与建议，并在原表格末尾新增“入选原因（简短）”一列，每行一句话；见docs/参考视频报告要求-20261111.md。交最新可读候选报告/结构化数据/自查，未选中的不全量深拆。',
  session4: '用户点击【复盘-更新】。开工前先按docs/登录账号确认规则-20261111.md确认当前登录账号为运营账号/运营账号；未登录或账号不符立即停止并回传blocked。按会话4说明、docs/复盘深度要求-20261111.md与最新业务档案更新运营账号运营账号。Chrome只读核验本人账号及后台，更新可见7天/30天汇总、近期最多12条作品和新发布，保留观察时点/窗口/分母/来源，旧快照不覆盖。仅同作品同累计口径计算增量，滚动窗口差值不是新增。复盘必须逐条诊断并做三项结合：读会话1最新research/benchmarks分析做对标对照、读最新批次参考报告与scripts-output publication-map做机制对照、读最新research/platform-intelligence情报做合规/机会对照；给2–4个可检验实验，不做因果断言、不承诺流量。新建reviews独立目录的metrics.json/report.md/feedback.json，建议proposed。',
  session5: '用户点击【情报-更新】。开工前先按docs/登录账号确认规则-20261111.md确认抖音登录账号为研究专用号研究小号；未登录或账号不符立即停止并回传blocked。按会话5说明通过既有Edge只读更新最新规则、创作者功能、搜索/同城及增长案例，以最近已交报告作基线，优先近30天、兼顾上次更新后动态。最多12个详情来源；官方原文、媒体转述、单案例和假设分开；发布/转载/上线/生效日期分开，未核实不叫新规/新算法。重点本地家居获客相关，广告产品不当自然流量机制，公示不等于已生效也不能断言当前仍未生效。报告按docs/情报报告要求-20261111.md：标题为内容关键提炼、每项有来源链接、顶部放总体分析与建议。交research/platform-intelligence独立目录report.md/sources.json及证据；不安装监测、不设定时。',
};
const FOOTER = '\n遵守统一规则。写明实际截止时间、已完成/未知/阻碍；started和终态按本task_id原生回执。不发布/互动/投流/支付、不跨会话派工、不设置定时。';

export class DashboardActions {
  constructor({ root, store, dispatch, findHandoff = findReadyHandoff }) {
    this.root = path.resolve(root); this.store = store; this.dispatch = dispatch; this.findHandoff = findHandoff;
    this.queue = Promise.resolve();
  }
  exclusive(fn) { const work = this.queue.catch(() => {}).then(fn); this.queue = work; return work; }
  async journal() {
    const dir = await safePath(this.root, 'control/sidebar-dashboard/actions', { createDirectory: true });
    return new Journal(dir);
  }
  async cards(peer, sessionId, signal) {
    assertOwner(peer, sessionId);
    const cards = await this.store.listCards();
    let records;
    try { records = await this.dispatch().records(peer, sessionId, signal); }
    catch (e) { return { cards, dispatchAvailable: false, dispatchError: e.message }; }
    return { dispatchAvailable: true, cards: cards.map(card => {
      const matching = records.filter(r => r.target === card.key && r.kind === 'task').sort((a,b) => b.created_at.localeCompare(a.created_at));
      const current = matching.find(r => !terminal(r.status)) ?? matching[0];
      return { ...card, task: current ? { taskId: current.task_id, status: current.status, updatedAt: current.reported_at ?? current.accepted_at ?? current.created_at, summary: current.summary ?? '', busy: !terminal(current.status) } : null };
    }) };
  }
  async update(peer, args, signal) {
    assertOwner(peer, args.controllerSessionId); need(UPDATE_KEYS.has(args.key), '该卡片不提供更新派工');
    return this.act(peer, args, 'update', signal);
  }
  async createScript(peer, args, signal) {
    assertOwner(peer, args.controllerSessionId); need(exactVideoId(args.videoId), '作品ID不合法');
    need(typeof args.requirement === 'string' && args.requirement.length <= 2000, '本次做剧本要求不合法');
    return this.act(peer, args, 'create-script', signal);
  }
  async deepDive(peer, args, signal) {
    assertOwner(peer, args.controllerSessionId); need(exactVideoId(args.videoId), '作品ID不合法');
    return this.act(peer, args, 'deep-dive', signal);
  }
  async adjustScript(peer, args, signal) {
    assertOwner(peer, args.controllerSessionId);
    need(exactUuid(args.actionId), '缺少合法操作ID');
    need(typeof args.requirement === 'string' && args.requirement.trim().length > 0 && args.requirement.length <= 2000, '调整剧本要求不合法');
    return this.act(peer, args, 'adjust-script', signal);
  }
  async act(peer, args, operation, signal) {
    assertOwner(peer, args?.controllerSessionId);
    need(operation === 'update' || operation === 'create-script' || operation === 'deep-dive' || operation === 'adjust-script', '不支持的操作');
    if (operation === 'update') need(UPDATE_KEYS.has(args.key), '该卡片不提供更新派工');
    need(exactUuid(args.actionId), '缺少合法操作ID');
    return this.exclusive(async () => {
      const actionKey = `click-${args.actionId}`;
      const j = await this.journal();
      // Reject a symlink at the action file, not just at its parent.
      const existingPath = path.relative(this.root, j.file(actionKey));
      try { await safePath(this.root, existingPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      let record = await j.get(actionKey);
      const identity = operation === 'update' ? { operation, key: args.key }
        : operation === 'create-script' ? { operation, reportId: args.reportId, videoId: args.videoId, requirement: args.requirement }
          : operation === 'adjust-script' ? { operation, reportId: args.reportId, requirement: args.requirement }
            : { operation, reportId: args.reportId, videoId: args.videoId };
      const fingerprint = sha(JSON.stringify(identity));
      if (record) need(record.fingerprint === fingerprint, '操作ID已用于其他请求', 'CONFLICT');
      if (!record) {
        let target, instruction, handoff, selected, needsVerification = false;
        if (operation === 'update') { target = args.key; instruction = UPDATES[target] + FOOTER; }
        else if (operation === 'adjust-script') {
          const report = await this.store.getReport(args.reportId);
          need(report.key === 'session3', '只能调整原创剧本报告');
          target = 'session3';
          instruction = `用户在总管侧栏原创剧本报告演示底部点击“调整剧本”，调整要求：${args.requirement.trim()}。按会话3说明读取并修订该剧本：${report.relativePath}（先读原文；保留旧版本，不覆盖）。在 scripts-output/<批次>/<同目录>/ 下写新版本 script-*.md（版本号递增，不覆盖旧文件），并更新 scripts.json 的版本字段；新版本必须保留清晰的二级标题：具体剧本（时间轴分镜）、口播文案、标题备选、封面建议。以用户本次调整要求为准；不得虚构尺寸/价格/案例/效果，不代发、不发布；与事实边界冲突处标注待核。终态回执附新版本路径、版本号与主要差异摘要。` + FOOTER;
        } else {
          const report = await this.store.getReport(args.reportId);
          need(report.key === 'session2', '只能从参考视频报告选片');
          selected = report.videos.find(v => v.videoId === args.videoId);
          need(selected, '作品不在该报告中');
          if (operation === 'deep-dive') {
            target = 'session2';
            instruction = `用户在总管侧栏参考视频报告点击“拆解”，要求深拆该条参考视频：video_id=${args.videoId}，链接https://www.douyin.com/video/${args.videoId}。开工前先按docs/登录账号确认规则-20261111.md确认抖音登录账号为研究专用号研究小号；未登录或账号不符立即停止并回传blocked。按会话2说明对该单条做全片结构观察（不把抽帧冒充全片）与评论抽样；必须按docs/豆包文案提取规则-20261111.md用豆包【新工作任务】→【工作】模式（普通聊天无法访问抖音链接），把公开链接与该提示词一起发送：“请提取这个抖音视频的完整口播文案（逐字稿），不要只做摘要，尽量逐句输出，并标注听不清的地方：”，并把逐字稿纳入card/evidence/deep-check/handoff-input分析；保存doubao-copy-raw.md、doubao-copy-meta.json、doubao-copy-reviewed.md（标“AI辅助整理，未经真人审核”）。豆包不可用/未登录/只给摘要时标blocked或partial，不换其他AI、不用旧摘要冒充。新增revision不覆盖旧版，未知口播/尺寸/效果标待核，不编造；不生成selection/handoff、不启动会话3、不发布。用户点击记录在control/sidebar-dashboard/actions/${actionKey}.json；终态回执附路径、结论与缺口。` + FOOTER;
          } else {
            handoff = await this.findHandoff(this.root, args.videoId);
            target = handoff ? 'session3' : 'session2'; needsVerification = !handoff;
            instruction = handoff
              ? `用户在总管侧栏参考视频报告点击“做原创剧本”，明确选中video_id=${args.videoId}，用户本次做剧本要求：${args.requirement || '未填写特别要求，按账号定位与参考机制创作'}。按会话3说明与v2单条交接协议，先校验${handoff.directory}的selection.json/handoff.json，固定SHA256=${handoff.sha256}；运行python scripts/selected_handoff.py status ${handoff.directory} --expected-hash ${handoff.sha256}，须三项ready且ID一致才创作。为运营账号写1条独立原创可拍草稿（完整口播、分镜、标题封面、发布文案、事实核验）；优先满足用户本次要求，未知尺寸效果/案例/价格不编，参考表达和镜头不照搬。写scripts-output/${handoff.batchId}/ui-${args.actionId}/，带scripts.json与publication-map.json（发布值null）。` + FOOTER
              : `用户在总管侧栏参考视频报告点击“做原创剧本”，明确选中video_id=${args.videoId}，链接https://www.douyin.com/video/${args.videoId}，用户本次做剧本要求：${args.requirement || '未填写特别要求，按账号定位与参考机制创作'}。开工前先按docs/登录账号确认规则-20261111.md确认抖音登录账号为研究专用号研究小号；未登录或账号不符立即停止并回传blocked。此点击授权“补核、验收交接后由会话3原创”的依赖流程，尚无有效交接；先按会话2说明补核该单条，复用既有可信证据并保留历史，不重采整库、不把抽帧冒充全片。必须按docs/豆包文案提取规则-20261111.md用豆包【新工作任务】→【工作】模式（普通聊天无法访问抖音链接），把公开链接与该提示词一起发送：“请提取这个抖音视频的完整口播文案（逐字稿），不要只做摘要，尽量逐句输出，并标注听不清的地方：”，并把逐字稿纳入card/evidence/deep-check/handoff-input分析；保存doubao-copy-raw.md、doubao-copy-meta.json、doubao-copy-reviewed.md（标“AI辅助整理，未经真人审核”）。豆包不可用、未登录或只给摘要时，该作品深拆不得标完成，回传blocked/partial与原因，不擅自换其他AI服务、不用旧摘要冒充。新版本交card.md/evidence.json/deep-check.json/handoff-input.json，标注结构充足性和未知口播/尺寸/效果；不得自己标总管验收通过或直接启动会话3。用户点击及选片授权记录在control/sidebar-dashboard/actions/${actionKey}.json；终态附该路径供总管验收后续交接。` + FOOTER;
          }
        }
        record = { task_id: actionKey, fingerprint, identity, createdAt: new Date().toISOString(), authorization: 'authenticated-owner-explicit-sidebar-click', controllerSessionId: CONTROLLER, target, targetSessionId: TARGETS[target].id, navigateSessionId: operation === 'create-script' ? TARGETS.session3.id : TARGETS[target].id, needsVerification, selected: selected ?? null, handoff: handoff ?? null, dispatchArgs: { target, task_id: `ui-${target}-${args.actionId}`, kind: 'task', instruction }, state: 'prepared' };
        await j.create(record);
      }
      // Dispatcher deduplicates the stable native task ID across transport retries/restarts.
      const task = await this.dispatch().send(peer, args.controllerSessionId, record.dispatchArgs, signal);
      record.state = task.status; record.lastResult = { taskId: task.task_id, status: task.status }; await j.put(record);
      return { task: { taskId: task.task_id, status: task.status }, status: task.status, targetSessionId: record.navigateSessionId, executionSessionId: record.targetSessionId, needsVerification: record.needsVerification };
    });
  }
}
