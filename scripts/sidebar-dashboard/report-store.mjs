import path from 'node:path';
import { promises as fs, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { buildInsights } from './insights.mjs';
import { MAX_COVER_BYTES, coverFileOf, coverTypeOf, markdownCoverPath } from './covers.mjs';

const MAX_BYTES = 1024 * 1024;
const CONTROL = 'control/sidebar-dashboard';
const MANIFEST = `${CONTROL}/manifest.json`;
const MODULES = [
  ['session1', '对标账号', 'research/benchmarks'],
  ['session2', '参考视频', 'batches'],
  ['session3', '原创剧本', 'scripts-output'],
  ['session4', '复盘', 'reviews'],
  ['session5', '情报', 'research/platform-intelligence'],
];
// Shared across instances, not merely across requests on one instance.
const locks = new Map();
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), { code });
const isMissing = error => error.code === 'ENOENT';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const listOf = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const reportId = (key, relativePath) => `r_${hash(`${key}\0${relativePath}`)}`;
const titleOf = (markdown, fallback) => markdown.match(/^#\s+(.+)$/m)?.[1].trim() || fallback;
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const dateValue = value => {
  if (typeof value !== 'string') return null;
  // Workspace dates are Asia/Shanghai. Never let the server's local timezone decide.
  const match = value.match(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) return null;
  let date = value.replace(' ', 'T');
  if (date.length === 10) date += 'T00:00:00+08:00';
  else if (!/(Z|[+-]\d{2}:?\d{2})$/.test(date)) date += '+08:00';
  const millis = Date.parse(date);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};
const DATE_TOKEN = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

function markdownDate(markdown) {
  const lines = markdown.split(/\r?\n/).slice(0, 30);
  const section = lines.findIndex(line => /^##\s/.test(line));
  const header = section < 0 ? lines : lines.slice(0, section);
  for (const labels of [
    /(?:分析截止|报告截止|数据截止|截止时间|截止|更新(?:时间|于)?|updated_at|revised_at)\s*[：:]\s*[*`\s]*/i,
    /(?:生成时间|生成于|报告时间|generated_at)\s*[：:]\s*[*`\s]*/i,
  ]) {
    for (const line of header) {
      if (!/^\s*[-*>]|^\s*(?:更新|分析截止|生成时间)/.test(line)) continue;
      const label = labels.exec(line.replace(/\*\*/g, ''));
      if (!label) continue;
      const after = line.replace(/\*\*/g, '').slice(label.index + label[0].length);
      const token = after.match(DATE_TOKEN)?.[0];
      if (token && after.indexOf(token) < 3 && dateValue(token)) return dateValue(token);
    }
  }
  return null;
}

function metadataDate(data) {
  if (!isObject(data)) return null;
  for (const name of ['updatedAt', 'updated_at', 'revised_at', 'analysis_cutoff', 'report_cutoff', 'cutoff_at', 'generated_at', 'created_at']) {
    const value = dateValue(data[name]);
    if (value) return { value, field: name };
  }
  for (const name of ['window', 'frozen_window']) {
    const value = dateValue(data[name]?.end);
    if (value) return { value, field: `${name}.end` };
  }
  return null;
}

function videoRows(data) {
  if (Array.isArray(data)) return data;
  for (const key of ['candidates', 'videos', 'items']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function extractVideos(markdown, documents) {
  const videos = new Map();
  const optional = (target, key, value) => {
    if (value !== undefined && value !== null && value !== '') target[key] = value;
  };
  // Data only: HTML/Markdown is deliberately not rendered or evaluated here.
  for (const data of documents) {
    for (const row of videoRows(data)) {
      if (!isObject(row)) continue;
      const videoId = text(row.video_id || row.videoId);
      if (!/^\d{5,30}$/.test(videoId)) continue;
      const previous = videos.get(videoId);
      const url = text(row.url || row.source?.url);
      const item = {
        videoId,
        code: text(row.code) || previous?.code || '',
        title: text(row.topic || row.title) || previous?.title || videoId,
        url: url || previous?.url || '',
        // A comment/cover pass or old materials.summary is NOT deep-dive readiness.
        referenceState: text(row.referenceState || row.reference_state || row.deep_dive_status) || previous?.referenceState || 'unknown',
      };
      optional(item, 'rank', Number.isInteger(row.rank) ? row.rank : previous?.rank);
      optional(item, 'category', text(row.category) || previous?.category);
      optional(item, 'account', text(row.account_name) || text(row.benchmark_account?.name) || previous?.account);
      optional(item, 'likes', typeof row.likes === 'number' ? row.likes : previous?.likes);
      optional(item, 'comments', typeof row.comments === 'number' ? row.comments : previous?.comments);
      optional(item, 'likesDisplay', text(row.metric_display?.likes_raw) || previous?.likesDisplay);
      optional(item, 'commentsDisplay', text(row.metric_display?.comments_raw) || previous?.commentsDisplay);
      optional(item, 'publishedAt', text(row.published_at) || previous?.publishedAt);
      optional(item, 'coverFile', coverFileOf(row) || previous?.coverFile);
      videos.set(videoId, item);
    }
  }
  // The original-layout report appends one short 入选原因 column; keep table
  // semantics and attach the reason without restructuring anything.
  let reasonColumn = -1;
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line) || !/入选原因/.test(line)) continue;
    const cells = line.split('|').map(part => part.trim());
    const index = cells.findIndex(cell => /入选原因/.test(cell));
    if (index > 1) { reasonColumn = index; break; }
  }
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\s*\|\s*[SBHC]\d+\s*\|/.test(line)) continue;
    const columns = line.split('|').map(part => part.trim());
    const code = columns[1];
    const url = line.match(/https:\/\/(?:www\.)?douyin\.com\/video\/(\d{5,30})/);
    if (!url) continue;
    const videoId = url[1];
    const previous = videos.get(videoId);
    const cover = markdownCoverPath(line);
    const hasCover = /!\[/.test(columns[3] || '');
    const item = {
      videoId, code,
      title: previous?.title || columns[hasCover ? 5 : 4] || videoId,
      url: previous?.url || url[0],
      referenceState: previous?.referenceState || 'unknown',
    };
    if (previous) {
      for (const key of ['rank', 'category', 'account', 'likes', 'comments', 'likesDisplay', 'commentsDisplay', 'publishedAt', 'coverFile']) {
        if (previous[key] !== undefined) item[key] = previous[key];
      }
    }
    if (!item.coverFile && cover) item.coverFile = cover;
    if (reasonColumn > 1) {
      const reason = text(columns[reasonColumn]).replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
      if (reason) item.reason = reason.slice(0, 400);
    }
    videos.set(videoId, item);
  }
  // Newer reports (v4) list each candidate as a block with its selection reason.
  // Parse only from the explicit 入选原因 label; never infer a reason from titles.
  const clean = value => value
    .replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  const lines = markdown.split(/\r?\n/);
  let block = null;
  const flush = () => {
    if (!block) return;
    const reason = clean(block.parts.filter(part => part && part.trim()).join('；')).replace(/^[；;]+|[；;]+$/g, '').slice(0, 400);
    if (reason) {
      const target = block.code ? [...videos.values()].find(video => video.code === block.code) : undefined;
      if (target) target.reason = reason;
    }
    block = null;
  };
  for (const line of lines) {
    const heading = line.match(/^#{3,4}\s+([SBHC]\d+)\s*[｜|·]\s*(.+?)\s*$/);
    if (/^#{3,4}\s/.test(line)) { flush(); block = heading ? { code: heading[1], parts: [], collecting: false } : null; continue; }
    if (!block) continue;
    const label = line.match(/^\s*[-*]?\s*\*{0,2}入选原因\*{0,2}\s*[：:]\s*(.*)$/);
    if (label) { block.collecting = true; if (label[1].trim()) block.parts.push(label[1].trim()); continue; }
    if (!block.collecting) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) { block.parts.push(bullet[1].trim()); continue; }
    if (!line.trim()) continue;
    if (block.parts.length) block.parts[block.parts.length - 1] = `${block.parts[block.parts.length - 1]} ${line.trim()}`;
  }
  flush();
  return [...videos.values()];
}

/** Fixed-scope, local-only report repository. The root is trusted configuration, never a request path.
 * User edits live exclusively in control/sidebar-dashboard/edits, away from production drafts.
 * Manifest is the commit point; unreferenced files after a failed write are harmless orphans.
 * All descendants that are symlinks/junctions are rejected, including in-root aliases.
 */
export class ReportStore {
  #root;
  #rootReady;

  constructor({ root } = {}) {
    if (typeof root !== 'string' || !root) throw fail('INVALID_ROOT', 'root is required');
    this.#root = path.resolve(root);
    this.#rootReady = null;
  }

  async #ready() {
    if (!this.#rootReady) this.#rootReady = fs.realpath(this.#root).then(async canonical => {
      if (!(await fs.stat(canonical)).isDirectory()) throw fail('INVALID_ROOT', 'root must be a directory');
      this.#root = canonical;
      return canonical;
    });
    return this.#rootReady;
  }

  #resolve(relativePath) {
    if (typeof relativePath !== 'string' || !relativePath || /[\\:\0]/.test(relativePath)
      || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw fail('PATH_ESCAPE', 'Invalid relative path');
    }
    const absolute = path.resolve(this.#root, ...relativePath.split('/'));
    if (!inside(this.#root, absolute)) throw fail('PATH_ESCAPE', 'Path is outside workspace');
    return absolute;
  }

  async #existing(relativePath) {
    await this.#ready();
    const absolute = this.#resolve(relativePath);
    let cursor = this.#root;
    for (const segment of relativePath.split('/')) {
      cursor = path.resolve(cursor, segment);
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw fail('PATH_ESCAPE', 'Symlink/junction paths are not allowed');
      const real = await fs.realpath(cursor);
      if (!inside(this.#root, real)) throw fail('PATH_ESCAPE', 'Real path is outside workspace');
    }
    return absolute;
  }

  async #read(relativePath) {
    const absolute = await this.#existing(relativePath);
    const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail('INVALID_FILE', 'Expected a regular file');
      if (stat.size > MAX_BYTES) throw fail('TOO_LARGE', 'File exceeds 1 MiB');
      // Bounded read also prevents an append race from allocating an unbounded buffer.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw fail('TOO_LARGE', 'File exceeds 1 MiB');
      await this.#existing(relativePath);
      return { markdown: buffer.subarray(0, size).toString('utf8'), stat };
    } finally { await handle.close(); }
  }

  async #optionalJson(relativePath) {
    try {
      const { markdown } = await this.#read(relativePath);
      return JSON.parse(markdown.replace(/^\uFEFF/, ''));
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async #entries(relativePath) {
    try {
      return (await fs.readdir(await this.#existing(relativePath), { withFileTypes: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async #candidates() {
    const result = [];
    const add = (key, relativePath) => result.push({ key, relativePath, id: reportId(key, relativePath) });
    for (const [key, , base] of MODULES) {
      const top = await this.#entries(base);
      if (key === 'session1') {
        for (const item of top) if (item.isFile() && /^report(?:[-_].+)?\.md$/i.test(item.name)) add(key, `${base}/${item.name}`);
      }
      for (const directory of top.filter(item => item.isDirectory())) {
        const parent = `${base}/${directory.name}`;
        const files = await this.#entries(parent);
        const names = new Set(files.filter(item => item.isFile()).map(item => item.name));
        if (key === 'session2') {
          const preferred = ['quick-pick-v8.md', 'quick-pick-v7.md', 'quick-pick-v6.md', 'quick-pick-v5.md', 'quick-pick-v4.md', 'quick-pick-v3.md', 'quick-pick-v2.md', 'quick-pick.md', 'report.md'].find(name => names.has(name));
          if (preferred) add(key, `${parent}/${preferred}`);
        } else if (key === 'session3') {
          for (const item of files) {
            if (item.isFile() && /^script-.+\.md$/i.test(item.name)) add(key, `${parent}/${item.name}`);
            if (item.isDirectory() && item.name !== 'user-edits') {
              for (const child of await this.#entries(`${parent}/${item.name}`)) {
                if (child.isFile() && /^script-.+\.md$/i.test(child.name)) add(key, `${parent}/${item.name}/${child.name}`);
              }
            }
          }
        } else if (key === 'session1') {
          for (const name of names) if (/^report(?:[-_].+)?\.md$/i.test(name)) add(key, `${parent}/${name}`);
        } else {
          for (const name of key === 'session5' ? ['report.md', 'pilot-report.md'] : ['report.md']) {
            if (names.has(name)) add(key, `${parent}/${name}`);
          }
        }
      }
    }
    return result;
  }

  async #manifest() {
    let data;
    try { data = JSON.parse((await this.#read(MANIFEST)).markdown); }
    catch (error) {
      if (isMissing(error)) return { schemaVersion: 1, reports: {} };
      if (error instanceof SyntaxError) throw fail('INVALID_MANIFEST', 'Invalid edit manifest');
      throw error;
    }
    if (!isObject(data) || data.schemaVersion !== 1 || !isObject(data.reports)) throw fail('INVALID_MANIFEST', 'Invalid edit manifest');
    for (const [id, record] of Object.entries(data.reports)) {
      if (!/^r_[a-f0-9]{64}$/.test(id) || !isObject(record) || !Array.isArray(record.versions) || !record.versions.length) throw fail('INVALID_MANIFEST', 'Invalid edit record');
      const seen = new Set();
      for (const version of record.versions) {
        if (!isObject(version) || !/^[a-f0-9-]{36}$/.test(version.versionId) || seen.has(version.versionId)
          || !/^[a-f0-9]{64}$/.test(version.revision) || !dateValue(version.createdAt)) throw fail('INVALID_MANIFEST', 'Invalid version');
        seen.add(version.versionId);
      }
      if (record.current !== record.versions.at(-1).versionId) throw fail('INVALID_MANIFEST', 'Invalid edit pointer');
    }
    return data;
  }

  async #date(relativePath, markdown, stat) {
    const fromReport = markdownDate(markdown);
    if (fromReport) return { updatedAt: fromReport, updatedAtSource: 'report' };
    const directory = path.posix.dirname(relativePath);
    const stem = path.posix.basename(relativePath, '.md');
    const metadata = [...new Set([`${stem}.json`, 'metadata.json', 'scripts.json', 'metrics.json', 'operations.json', 'sources.json', 'source-list.json', 'evidence-summary.json', 'verify.json', 'batch.json'])];
    for (const name of metadata) {
      const found = metadataDate(await this.#optionalJson(`${directory}/${name}`));
      if (found) return { updatedAt: found.value, updatedAtSource: `metadata:${name}:${found.field}` };
    }
    return { updatedAt: stat.mtime.toISOString(), updatedAtSource: 'mtime' };
  }

  async #insights(candidate) {
    const directory = path.posix.dirname(candidate.relativePath);
    const stem = path.posix.basename(candidate.relativePath, '.md');
    try {
      switch (candidate.key) {
        case 'session1': return buildInsights('session1', {
          operations: await this.#optionalJson(`${directory}/operations.json`),
          benchmarks: await this.#optionalJson('data/benchmarks.json'),
        });
        case 'session2': {
          let quick = await this.#optionalJson(`${directory}/${stem}.json`);
          if (!isObject(quick) || !Array.isArray(quick.candidates)) {
            for (const name of ['quick-pick-v8.json', 'quick-pick-v7.json', 'quick-pick-v6.json', 'quick-pick-v5.json', 'quick-pick-v4.json', 'quick-pick-v3.json', 'quick-pick-v2.json', 'quick-pick.json']) {
              quick = await this.#optionalJson(`${directory}/${name}`);
              if (isObject(quick) && Array.isArray(quick.candidates)) break;
            }
          }
          let deepDives = 0;
          try {
            const entries = await fs.readdir(await this.#existing(`${directory}/deep-dives`), { withFileTypes: true });
            deepDives = entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).length;
          } catch { /* no deep-dive directory is a valid state */ }
          return buildInsights('session2', quick, { deepDives });
        }
        case 'session3': return buildInsights('session3', await this.#optionalJson(`${directory}/scripts.json`));
        case 'session4': return buildInsights('session4', await this.#optionalJson(`${directory}/metrics.json`));
        case 'session5': return buildInsights('session5', await this.#optionalJson(`${directory}/sources.json`));
      }
    } catch (error) {
      // Analytics are a presentation aid: an unreadable optional source must not break the report.
      if (error.code === 'PATH_ESCAPE' || error.code === 'INVALID_FILE') return null;
      throw error;
    }
    return null;
  }

  async #materialize(candidate, manifest, withVideos = false) {
    const source = await this.#read(candidate.relativePath);
    let markdown = source.markdown;
    let relativePath = candidate.relativePath;
    let date = await this.#date(relativePath, markdown, source.stat);
    const record = candidate.key === 'session3' ? manifest.reports[candidate.id] : null;
    const history = (record?.versions || []).map(({ versionId, createdAt, revision }) => ({ versionId, createdAt, revision }));
    if (record) {
      const current = record.versions.at(-1);
      relativePath = `${CONTROL}/edits/${candidate.id}/${current.versionId}.md`;
      markdown = (await this.#read(relativePath)).markdown;
      if (hash(markdown) !== current.revision) throw fail('INVALID_MANIFEST', 'Edited content hash mismatch');
      date = { updatedAt: current.createdAt, updatedAtSource: 'user-edit' };
    }
    let videos = [];
    let accounts = [];
    let transcripts = [];
    let insights = null;
    if (withVideos) {
      insights = await this.#insights(candidate);
      if (candidate.key === 'session2') {
        const directory = path.posix.dirname(candidate.relativePath);
        const stem = path.posix.basename(candidate.relativePath, '.md');
        const documents = [await this.#optionalJson(`${directory}/videos.json`), await this.#optionalJson(`${directory}/self-selected.json`)];
        if (stem !== 'report') documents.push(await this.#optionalJson(`${directory}/${stem}.json`));
        // A later report version may not carry a structured twin; reuse the newest
        // candidate document so the video library never loses rows.
        for (const name of ['quick-pick-v8.json', 'quick-pick-v7.json', 'quick-pick-v6.json', 'quick-pick-v5.json', 'quick-pick-v4.json', 'quick-pick-v3.json', 'quick-pick-v2.json']) {
          if (name !== `${stem}.json`) documents.push(await this.#optionalJson(`${directory}/${name}`));
        }
        videos = extractVideos(markdown, documents);
        videos = await this.#withCoverUrls(candidate, directory, videos);
        const dives = await this.#deepDiveIndex(directory);
        if (dives.size) videos = videos.map(video => dives.has(video.videoId) ? { ...video, deepDived: true, deepDiveRevision: dives.get(video.videoId) } : video);
        transcripts = await this.#transcripts(directory, videos.filter(video => video.deepDived));
      }
      if (candidate.key === 'session1') accounts = await this.#accounts(candidate, markdown);
    }
    return {
      id: candidate.id, key: candidate.key, title: titleOf(markdown, path.posix.basename(candidate.relativePath)),
      markdown, revision: hash(markdown), ...date, relativePath,
      editable: candidate.key === 'session3', history, videos, accounts, transcripts, insights,
    };
  }

  /** Load the saved transcript text for each deep-dived video (report-level view). */
  async #transcripts(directory, videos) {
    const result = [];
    for (const video of videos.slice(0, 12)) {
      const revision = Number.isInteger(video.deepDiveRevision) ? video.deepDiveRevision : null;
      const base = revision === null ? `${directory}/deep-dives/${video.videoId}` : `${directory}/deep-dives/${video.videoId}/revision-${revision}`;
      const readOptional = async name => {
        try { return (await this.#read(`${base}/${name}`)).markdown.trim().slice(0, 60000); }
        catch (error) { if (isMissing(error)) return ''; throw error; }
      };
      const raw = await readOptional('doubao-copy-raw.md');
      const reviewed = await readOptional('doubao-copy-reviewed.md');
      if (raw || reviewed) result.push({ videoId: video.videoId, code: video.code || '', title: video.title || '', revision, raw, reviewed });
    }
    return result;
  }

  /** One card per confirmed benchmark account, read from its own account directory. */
  async #accounts(candidate, markdown = '') {
    const directory = path.posix.dirname(candidate.relativePath);
    // The per-account 3.x analysis sections move into each card's detail view.
    const analyses = new Map();
    let currentId = null;
    let buffer = [];
    const flush = () => {
      if (currentId && buffer.length) {
        const value = buffer.join('\n').trim();
        if (value) analyses.set(currentId, value.slice(0, 6000));
      }
      currentId = null; buffer = [];
    };
    for (const line of markdown.split(/\r?\n/)) {
      const heading = line.match(/^###\s+3\.\d+\s+.*?(acct-[0-9A-Za-z_-]+)/i);
      if (heading) { flush(); currentId = heading[1]; continue; }
      if (/^##\s/.test(line)) { flush(); continue; }
      if (currentId) buffer.push(line);
    }
    flush();
    const sync = await this.#optionalJson(`${directory}/sync-manifest.json`);
    let entries = Array.isArray(sync?.accounts) ? sync.accounts : [];
    if (!entries.length) {
      try {
        entries = (await fs.readdir(await this.#existing(`${directory}/accounts`), { withFileTypes: true }))
          .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
          .map(entry => ({ account_id: entry.name }));
      } catch { return []; }
    }
    const result = [];
    for (const entry of entries.slice(0, 30)) {
      const accountId = text(entry?.account_id || entry?.accountId);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId)) continue;
      const base = `${directory}/accounts/${accountId}`;
      const profile = await this.#optionalJson(`${base}/profile.json`);
      const videoFile = await this.#optionalJson(`${base}/videos.json`);
      const commentFile = await this.#optionalJson(`${base}/comments.json`);
      const rows = listOf(videoFile?.videos).filter(isObject);
      const newRows = rows.filter(row => row.is_new_since_last_cutoff === true);
      let profileImage = null;
      try {
        await this.#existing(`${base}/profile.png`);
        profileImage = `accounts/${accountId}/profile.png`;
      } catch { /* screenshot unavailable is a recorded gap */ }
      const videos = (newRows.length ? newRows : rows).slice(0, 20).map(row => ({
        videoId: text(row.video_id || row.videoId),
        url: text(row.url),
        title: text(row.caption || row.title || row.topic) || text(row.video_id),
        publishedAt: text(row.publish_time || row.published_at),
        likesDisplay: text(row.likes_display),
        commentsDisplay: text(row.comments_display),
        isNew: row.is_new_since_last_cutoff === true,
      })).filter(row => /^\d{5,30}$/.test(row.videoId));
      const commentRows = listOf(commentFile?.videos).filter(isObject);
      const commentSamples = commentRows.reduce((sum, row) => sum + (Number.isFinite(row.sample_size) ? row.sample_size : 0), 0);
      result.push({
        accountId,
        name: text(profile?.name || entry?.name) || accountId,
        profileUrl: text(profile?.profile_url || entry?.profile_url),
        profileImage,
        capturedAt: text(profile?.captured_at),
        status: text(profile?.status || 'available'),
        douyinId: text(profile?.observed_profile_fields?.douyin_id),
        fansDisplay: text(profile?.observed_profile_fields?.fans_display),
        worksDisplay: text(profile?.observed_profile_fields?.works_count_display),
        ipRegion: text(profile?.observed_profile_fields?.ip_region),
        newVideoCount: newRows.length,
        sampledVideoCount: rows.length,
        commentSamples,
        commentNote: text(commentFile?.note),
        analysis: analyses.get(accountId) || '',
        videos,
      });
    }
    return result;
  }

  /** Replace internal cover paths with an opaque, authenticated read URL. */
  async #withCoverUrls(candidate, directory, videos) {
    const result = [];
    for (const video of videos) {
      const file = video.coverFile;
      if (!file || !coverTypeOf(file)) { const { coverFile, ...rest } = video; result.push(rest); continue; }
      try {
        const absolute = await this.#existing(`${directory}/${file}`);
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.size > MAX_COVER_BYTES) throw fail('INVALID_FILE', 'Unusable cover');
        const { coverFile, ...rest } = video;
        result.push({ ...rest, coverUrl: `/api/douyin-cover?reportId=${candidate.id}&videoId=${video.videoId}`, coverBytes: stat.size });
      } catch {
        const { coverFile, ...rest } = video;
        result.push(rest);
      }
    }
    return result;
  }

  /** Map deep-dived video ids to their newest revision (null = files at the video root). */
  async #deepDiveIndex(directory) {
    const map = new Map();
    let entries;
    try { entries = await fs.readdir(await this.#existing(`${directory}/deep-dives`), { withFileTypes: true }); }
    catch { return map; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\d{5,30}$/.test(entry.name)) continue;
      try {
        const children = await fs.readdir(await this.#existing(`${directory}/deep-dives/${entry.name}`), { withFileTypes: true });
        let revision = null;
        for (const child of children) {
          const match = child.isDirectory() && child.name.match(/^revision-(\d+)$/);
          if (match) revision = Math.max(revision ?? 0, Number(match[1]));
        }
        const rootCard = children.some(child => child.isFile() && child.name === 'card.md');
        if (revision === null && !rootCard) continue;
        map.set(entry.name, revision);
      } catch { /* an unreadable deep dive is not advertised */ }
    }
    return map;
  }

  /** Read one video's newest deep-dive summary for the sidebar detail view. */
  async deepDive(reportId, videoId) {
    if (typeof reportId !== 'string' || !/^r_[a-f0-9]{64}$/.test(reportId)) throw fail('NOT_FOUND', 'Unknown report');
    if (typeof videoId !== 'string' || !/^\d{5,30}$/.test(videoId)) throw fail('NOT_FOUND', 'Unknown video');
    await this.#ready();
    const candidate = (await this.#candidates()).find(item => item.id === reportId);
    if (!candidate || candidate.key !== 'session2') throw fail('NOT_FOUND', 'Unknown report');
    const directory = path.posix.dirname(candidate.relativePath);
    const revisions = await this.#deepDiveIndex(directory);
    if (!revisions.has(videoId)) throw fail('NOT_FOUND', '该视频尚未拆解');
    const revision = revisions.get(videoId);
    const base = revision === null ? `${directory}/deep-dives/${videoId}` : `${directory}/deep-dives/${videoId}/revision-${revision}`;
    const card = await this.#read(`${base}/card.md`);
    const deepCheck = await this.#optionalJson(`${base}/deep-check.json`);
    const transcript = await this.#optionalJson(`${base}/doubao-copy-meta.json`);
    let transcriptRaw = '';
    let transcriptReviewed = '';
    for (const [name, assign] of [['doubao-copy-raw.md', value => { transcriptRaw = value; }], ['doubao-copy-reviewed.md', value => { transcriptReviewed = value; }]]) {
      try { assign((await this.#read(`${base}/${name}`)).markdown); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
    const transcriptMarkdown = transcriptRaw || transcriptReviewed;
    const transcriptSource = transcriptRaw ? 'doubao-copy-raw.md' : transcriptReviewed ? 'doubao-copy-reviewed.md' : '';
    return {
      videoId,
      revision,
      cardMarkdown: card.markdown,
      transcriptMarkdown,
      transcriptSource,
      transcriptRaw,
      transcriptReviewed,
      deepCheck: isObject(deepCheck) ? deepCheck : null,
      transcript: isObject(transcript) ? {
        mode: text(transcript.mode),
        returnType: text(transcript.return_type || transcript.returnType),
        claimsWatched: transcript.claims_watched_video === true,
        limitations: listOf(transcript.limitations).map(item => text(item)).filter(Boolean).slice(0, 8),
      } : null,
    };
  }

  /** Resolve an authenticated cover request without ever accepting a client path. */
  async cover(reportId, videoId) {
    if (typeof reportId !== 'string' || !/^r_[a-f0-9]{64}$/.test(reportId)) return null;
    if (typeof videoId !== 'string' || !/^\d{10,24}$/.test(videoId)) return null;
    await this.#ready();
    const candidate = (await this.#candidates()).find(item => item.id === reportId);
    if (!candidate || candidate.key !== 'session2') return null;
    const directory = path.posix.dirname(candidate.relativePath);
    const stem = path.posix.basename(candidate.relativePath, '.md');
    const documents = [
      await this.#optionalJson(`${directory}/videos.json`),
      await this.#optionalJson(`${directory}/self-selected.json`),
      await this.#optionalJson(`${directory}/${stem}.json`),
      await this.#optionalJson(`${directory}/quick-pick-v8.json`),
      await this.#optionalJson(`${directory}/quick-pick-v7.json`),
      await this.#optionalJson(`${directory}/quick-pick-v6.json`),
      await this.#optionalJson(`${directory}/quick-pick-v5.json`),
      await this.#optionalJson(`${directory}/quick-pick-v4.json`),
      await this.#optionalJson(`${directory}/quick-pick-v3.json`),
    ];
    let row = null;
    let fallback = null;
    for (const data of documents) {
      for (const item of videoRows(data)) {
        if (!isObject(item) || text(item.video_id || item.videoId) !== videoId) continue;
        // Older videos.json rows may predate cover collection: keep searching for
        // the document that actually carries the cover file instead of stopping.
        if (coverFileOf(item)) { row = item; break; }
        fallback ??= item;
      }
      if (row) break;
    }
    row ??= fallback;
    const file = coverFileOf(row);
    const type = coverTypeOf(file);
    if (!file || !type) return null;
    try {
      const absolute = await this.#existing(`${directory}/${file}`);
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.size > MAX_COVER_BYTES) return null;
      return { absolute, type, size: stat.size };
    } catch { return null; }
  }

  async #all() {
    const candidates = await this.#candidates();
    const manifest = await this.#manifest();
    const reports = [];
    for (const candidate of candidates) reports.push(await this.#materialize(candidate, manifest));
    // A directory suffix -v2/-v3 marks a later revision of the same report; it wins
    // date ties so a revised report is not shadowed by the original directory.
    const version = report => {
      const directory = path.posix.dirname(report.relativePath).split('/').pop() || '';
      const match = directory.match(/-v(\d+)$/);
      return match ? Number(match[1]) : 0;
    };
    return reports.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || version(b) - version(a) || b.relativePath.localeCompare(a.relativePath));
  }

  /** Resolve a report-relative image (e.g. accounts/acct-001/profile.png) for authenticated display. */
  async asset(reportId, relativePath) {
    if (typeof reportId !== 'string' || !/^r_[a-f0-9]{64}$/.test(reportId)) return null;
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 240) return null;
    if (/[\\\0]/.test(relativePath) || relativePath.startsWith('/')) return null;
    const segments = relativePath.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment))) return null;
    const type = /\.png$/i.test(relativePath) ? 'image/png'
      : /\.jpe?g$/i.test(relativePath) ? 'image/jpeg'
        : /\.webp$/i.test(relativePath) ? 'image/webp' : null;
    if (!type) return null;
    await this.#ready();
    const candidate = (await this.#candidates()).find(item => item.id === reportId);
    if (!candidate) return null;
    const directory = path.posix.dirname(candidate.relativePath);
    try {
      const absolute = await this.#existing(`${directory}/${relativePath}`);
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.size > MAX_COVER_BYTES) return null;
      return { absolute, type, size: stat.size };
    } catch { return null; }
  }

  async listCards() {
    const reports = await this.#all();
    return MODULES.map(([key, title]) => {
      const latest = reports.find(report => report.key === key);
      return {
        key, title, updatedAt: latest?.updatedAt ?? null, updatedAtSource: latest?.updatedAtSource ?? null,
        reportId: latest?.id ?? null, reportTitle: latest?.title ?? null,
        editable: key === 'session3', empty: !latest,
      };
    });
  }

  async listReports(key) {
    if (!MODULES.some(module => module[0] === key)) throw fail('INVALID_KEY', 'Unknown module key');
    return (await this.#all()).filter(report => report.key === key)
      .map(({ id, key: moduleKey, title, updatedAt, relativePath, editable }) => ({ id, key: moduleKey, title, updatedAt, relativePath, editable }));
  }

  async getReport(id) {
    if (typeof id !== 'string' || !/^r_[a-f0-9]{64}$/.test(id)) throw fail('NOT_FOUND', 'Unknown report id');
    const candidate = (await this.#candidates()).find(item => item.id === id);
    if (!candidate) throw fail('NOT_FOUND', 'Unknown report id');
    return this.#materialize(candidate, await this.#manifest(), true);
  }

  async #mkdir(relativePath) {
    await this.#ready();
    this.#resolve(relativePath);
    const segments = relativePath.split('/');
    for (let index = 1; index <= segments.length; index++) {
      const relative = segments.slice(0, index).join('/');
      try { await fs.mkdir(this.#resolve(relative)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const absolute = await this.#existing(relative);
      if (!(await fs.stat(absolute)).isDirectory()) throw fail('INVALID_FILE', 'Expected edit directory');
    }
  }

  async #syncDirectory(relativePath) {
    // Node/Windows cannot portably fsync directory handles. File fsync + atomic same-dir
    // rename are mandatory on every platform; directory fsync is used where supported.
    const absolute = await this.#existing(relativePath);
    if (process.platform === 'win32') return;
    const handle = await fs.open(absolute, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #atomicWrite(relativePath, content) {
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw fail('TOO_LARGE', 'File exceeds 1 MiB');
    const directory = path.posix.dirname(relativePath);
    await this.#existing(directory);
    const target = this.#resolve(relativePath);
    try { await this.#existing(relativePath); } catch (error) { if (!isMissing(error)) throw error; }
    const tempRelative = `${directory}/.${randomUUID()}.tmp`;
    const temporary = this.#resolve(tempRelative);
    let handle;
    try {
      handle = await fs.open(temporary, 'wx', 0o600);
      await this.#existing(tempRelative);
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await this.#existing(directory);
      await this.#existing(tempRelative);
      try { await this.#existing(relativePath); } catch (error) { if (!isMissing(error)) throw error; }
      await fs.rename(temporary, target);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      // Only remove our validated, random temporary file; never follow a request path.
      try { await this.#existing(tempRelative); await fs.unlink(temporary); } catch { /* retain orphan on cleanup failure */ }
      throw error;
    }
  }

  async saveScript({ reportId: id, baseRevision, content } = {}) {
    if (typeof content !== 'string') throw fail('INVALID_CONTENT', 'content must be a string');
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw fail('TOO_LARGE', 'Content exceeds 1 MiB');
    await this.#ready();
    const lockKey = process.platform === 'win32' ? this.#root.toLowerCase() : this.#root;
    const previous = locks.get(lockKey) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await this.getReport(id);
      if (current.key !== 'session3') throw fail('READ_ONLY', 'Only session3 scripts can be edited');
      if (typeof baseRevision !== 'string' || baseRevision !== current.revision) throw fail('CONFLICT', 'Report changed; reload before saving');
      const original = (await this.#candidates()).find(candidate => candidate.id === id);
      if (!original) throw fail('NOT_FOUND', 'Unknown report id');
      const manifest = await this.#manifest();
      const version = { versionId: randomUUID(), createdAt: new Date().toISOString(), revision: hash(content) };
      const directory = `${CONTROL}/edits/${id}`;
      await this.#mkdir(directory);
      const relativePath = `${directory}/${version.versionId}.md`;
      await this.#atomicWrite(relativePath, content);
      await this.#syncDirectory(directory);
      const versions = [...(manifest.reports[id]?.versions || []), version];
      manifest.reports[id] = { current: version.versionId, versions };
      // No in-memory pointer/cache changes: any pre-commit error leaves the old manifest intact.
      await this.#atomicWrite(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
      // Rename is the commit point: avoid reporting a false rollback if a post-commit dir
      // flush is unsupported by the filesystem. File data was synced before the rename.
      await this.#syncDirectory(CONTROL).catch(() => {});
      return {
        ...current, title: titleOf(content, path.posix.basename(original.relativePath)), markdown: content, revision: version.revision,
        updatedAt: version.createdAt, updatedAtSource: 'user-edit', relativePath,
        history: versions.map(({ versionId, createdAt, revision }) => ({ versionId, createdAt, revision })), saved: true,
      };
    });
    locks.set(lockKey, operation);
    try { return await operation; }
    finally { if (locks.get(lockKey) === operation) locks.delete(lockKey); }
  }
}
