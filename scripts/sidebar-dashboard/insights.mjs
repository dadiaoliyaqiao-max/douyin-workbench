/**
 * Pure presentation analytics for the five report modules.
 *
 * These functions only transform already-loaded, workspace-local metadata into a
 * small JSON-safe chart specification. They never read files, never evaluate
 * report content, and never invent values: an absent source yields `null` (the
 * deck then falls back to text slides only).
 */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value : '';
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const kpi = (label, value, unit = '', hint = '') => ({ label, value: String(value ?? '—'), unit, hint });
const clean = (value, max = 48) => {
  const value2 = text(value).replace(/\s+/g, ' ').trim();
  return value2.length > max ? `${value2.slice(0, max)}…` : value2;
};
const percent = (value, digits = 1) => `${(value * 100).toFixed(digits).replace(/\.0+$/, '')}%`;
const day = value => {
  const raw = text(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw ? clean(raw, 16) : '—';
};

/** Parse "51.1万"/"1.2亿"/number counters into a number, or null when unreadable. */
export function parseCount(value) {
  const direct = num(value);
  if (direct !== null) return direct;
  const match = text(value).trim().match(/^([\d.]+)\s*(万|亿)?$/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  return Math.round(base * (match[2] === '万' ? 1e4 : match[2] === '亿' ? 1e8 : 1));
}

function group(values) {
  const counts = new Map();
  for (const value of values) {
    const key = clean(value, 24) || '未分类';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([label, value]) => ({ label, value }));
}

/** 会话1：已确认对标账号与运营机制样本。 */
export function session1Insights({ operations, benchmarks } = {}) {
  const accounts = list(operations?.accounts);
  const catalog = list(benchmarks?.accounts);
  if (!accounts.length && !catalog.length) return null;
  const scope = isObject(operations?.scope) ? operations.scope : {};
  const excluded = isObject(scope.excluded) ? scope.excluded : {};
  const confirmed = num(scope.confirmed_count) ?? accounts.length;
  const confirmedRows = catalog.filter(row => !row?.status || row.status === 'confirmed');
  const categories = group((confirmedRows.length ? confirmedRows : catalog).map(row => row?.category));
  const adopt = accounts.map(row => ({
    label: clean(row?.name, 12) || text(row?.account_id),
    value: list(row?.migration?.adopt).length,
  })).filter(item => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  const samples = accounts.map(row => ({
    label: clean(row?.name, 12) || text(row?.account_id),
    value: num(row?.samples?.total) ?? 0,
  })).filter(item => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  const gaps = list(operations?.evidence_gaps).length;
  return {
    kpis: [
      kpi('已确认账号', confirmed, '个'),
      kpi('候选排除', list(excluded.candidate).length, '个'),
      kpi('用户拒绝', list(excluded.rejected).length, '个'),
      kpi('证据缺口', gaps, '项'),
    ],
    charts: [
      { kind: 'donut', title: '账号类型构成', unit: '个', items: categories, center: { value: confirmed, unit: '个', label: '已确认' } },
      { kind: 'bars', title: '可迁移要点（按号）', unit: '条', format: 'count', items: adopt },
      { kind: 'bars', title: '样本作品数（按号）', unit: '条', format: 'count', items: samples },
      {
        kind: 'gauge', title: '评论抽样覆盖', value: 0, max: Math.max(confirmed, 1), display: '0%',
        caption: '本轮未取得评论样本，属于已记录证据缺口',
      },
    ],
    facts: [
      { label: '样本边界', value: `8号主页字段 + 每号10条作品卡；${accounts.length} 个账号有运营机制样本` },
      { label: '排序依据', value: '本轮无评论数，不能按评论优先排序，不作密度推断' },
    ],
  };
}

/** 会话2：50条参考视频候选与封面完整度。 */
export function session2Insights(quickPick, extras = {}) {
  if (!isObject(quickPick)) return null;
  const rows = list(quickPick.candidates).filter(isObject);
  if (!rows.length) return null;
  const labelOf = key => ({ benchmark: '对标账号', home: '家居家装', cross_industry: '跨行业热门' })[key] || clean(key, 16) || '未分类';
  const categories = group(rows.map(row => row.category)).map(item => ({ ...item, label: labelOf(item.label) }));
  const covers = rows.filter(row => row?.cover?.status === 'ok').length;
  const required = num(quickPick.covers_required) ?? rows.length;
  const marked = rows.filter(row => text(row?.deep_dive_status) && row.deep_dive_status !== 'not_started_quick_stage').length;
  const directories = Number.isInteger(extras.deepDives) && extras.deepDives > 0 ? extras.deepDives : 0;
  const deep = Math.max(marked, directories);
  const ranked = metric => rows.map(row => ({
    label: text(row?.code) || text(row?.video_id).slice(-6),
    value: parseCount(row?.[metric]) ?? 0,
    hint: clean(row?.topic, 36),
  })).sort((a, b) => b.value - a.value).slice(0, 8);
  const window = isObject(quickPick.frozen_window) ? quickPick.frozen_window : {};
  return {
    kpis: [
      kpi('候选视频', rows.length, '条'),
      kpi('真实封面', covers, `/${required}`, '') ,
      kpi('已深拆', deep, '条', directories ? '含本地深拆目录' : ''),
      kpi('冻结截止', day(window.end), ''),
    ],
    charts: [
      { kind: 'donut', title: '类别配额', unit: '条', items: categories, center: { value: rows.length, unit: '条', label: '候选' } },
      { kind: 'bars', title: '点赞 Top 8', unit: '赞', format: 'count', items: ranked('likes') },
      { kind: 'bars', title: '评论 Top 8', unit: '评', format: 'count', items: ranked('comments') },
      { kind: 'gauge', title: '封面取得率', value: covers, max: Math.max(required, 1), display: percent(required ? covers / required : 0, 0) },
    ],
    facts: [
      { label: '冻结窗口', value: `${day(window.start)} → ${day(window.end)}（Asia/Shanghai）` },
      { label: '排序规则', value: '同类评论优先、点赞其次；非家居仅近72小时' },
      { label: '候选≠验收', value: '深拆与交接通过后才能进入原创剧本' },
    ],
  };
}

/** 会话3：原创剧本结构与待核事实。 */
export function session3Insights(scripts) {
  const rows = list(scripts?.scripts).filter(isObject);
  if (!rows.length) return null;
  const script = rows[0];
  const timeline = list(script.timeline).filter(isObject);
  const segments = timeline.map((row, index) => {
    const match = text(row.time).match(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)/);
    const value = match ? Math.max(0, Number(match[2]) - Number(match[1])) : 1;
    return { label: `第${index + 1}段`, value: Math.round(value * 10) / 10, hint: clean(row.visual, 30) };
  });
  const estimated = isObject(script.estimated_duration_seconds) ? script.estimated_duration_seconds : {};
  const parts = ['timeline', 'full_voiceover', 'fact_boundary', 'copyright_and_compliance', 'ab_tests', 'publishing', 'cover'];
  const present = parts.filter(key => {
    const value = script[key];
    return Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : text(value).length > 0;
  }).length;
  return {
    kpis: [
      kpi('剧本', rows.length, '条'),
      kpi('分镜', timeline.length, '段'),
      kpi('主版时长', num(estimated.main_version) ?? '—', '秒'),
      kpi('待核事实', list(script.pending_facts).length, '项'),
    ],
    charts: [
      { kind: 'bars', title: '分镜时长分布', unit: '秒', format: 'seconds', items: segments },
      {
        kind: 'gauge', title: '结构完整度', value: present, max: parts.length, display: percent(present / parts.length, 0),
        caption: `${present}/${parts.length} 项结构文件字段齐备`,
      },
    ],
    facts: [
      { label: '制作状态', value: clean(script.status || script.production_status || '草稿', 40) },
      { label: '参考边界', value: clean(script.reference_note, 96) },
      { label: '标题备选', value: list(script.title_options).slice(0, 3).join(' ／ ') },
    ],
  };
}

/** 会话4：自有账号近7天/近30天复盘。 */
export function session4Insights(metrics) {
  if (!isObject(metrics)) return null;
  const windows = isObject(metrics.windows) ? metrics.windows : {};
  const current = isObject(windows.current) ? windows.current : {};
  const compare = isObject(metrics.comparisons) ? metrics.comparisons : {};
  const seven = isObject(compare.seven_day_comparison) ? compare.seven_day_comparison : {};
  const thirty = isObject(compare.thirty_day_comparison) ? compare.thirty_day_comparison : {};
  const now = isObject(seven.current) ? seven.current : {};
  const before = isObject(seven.previous) ? seven.previous : {};
  if (!Object.keys(now).length) return null;
  const pairs = [
    ['播放', 'plays_total', '次', 'count'],
    ['平均观看', 'avg_watch_time_seconds', '秒', 'seconds'],
    ['5秒完播', 'five_sec_completion_rate', '%', 'rate'],
    ['2秒跳出', 'two_sec_bounce_rate', '%', 'rate'],
    ['点赞净增', 'likes_net', '个', 'count'],
    ['粉丝净增', 'follower_net', '人', 'count'],
  ];
  const comparison = pairs.map(([label, key, unit, format]) => {
    const currentValue = num(now[key]);
    const previousValue = num(before[key]);
    if (currentValue === null && previousValue === null) return null;
    return {
      label, unit, format,
      current: format === 'rate' ? Math.round((currentValue ?? 0) * 1000) / 10 : currentValue,
      previous: format === 'rate' ? Math.round((previousValue ?? 0) * 1000) / 10 : previousValue,
    };
  }).filter(Boolean);
  const currentThirty = isObject(thirty.current) ? thirty.current : {};
  return {
    kpis: [
      kpi('7天播放', num(now.plays_total) ?? '—', '次'),
      kpi('5秒完播', num(now.five_sec_completion_rate) === null ? '—' : percent(now.five_sec_completion_rate), ''),
      kpi('2秒跳出', num(now.two_sec_bounce_rate) === null ? '—' : percent(now.two_sec_bounce_rate), ''),
      kpi('粉丝净增', num(now.follower_net) ?? '—', '人'),
    ],
    charts: [
      { kind: 'compare', title: '近7天与前7天（窗口不同，仅看方向）', items: comparison },
      {
        kind: 'gauge', title: '5秒完播率', value: num(now.five_sec_completion_rate) ?? 0, max: 1,
        display: num(now.five_sec_completion_rate) === null ? '—' : percent(now.five_sec_completion_rate),
        caption: '分母为平台可见播放量',
      },
      {
        kind: 'gauge', title: '2秒跳出率', value: num(now.two_sec_bounce_rate) ?? 0, max: 1,
        display: num(now.two_sec_bounce_rate) === null ? '—' : percent(now.two_sec_bounce_rate),
        caption: '越低越好；小样本不推断限流',
      },
      {
        kind: 'compare', title: '近30天与前30天（窗口不同，仅看方向）',
        items: [
          ['作品', 'posts', '条', 'count'],
          ['播放', 'plays_total', '次', 'count'],
          ['平均观看', 'avg_watch_time_seconds', '秒', 'seconds'],
          ['粉丝净增', 'follower_net', '人', 'count'],
        ].map(([label, key, unit, format]) => ({
          label, unit, format,
          current: num(thirty.current?.[key]),
          previous: num(thirty.previous?.[key]),
        })).filter(item => item.current !== null || item.previous !== null),
      },
    ],
    facts: [
      { label: '7天窗口', value: `${day(current.W7?.start)} → ${day(current.W7?.end)}（${day(metrics.platform_latest_available_date)} 为最新完整日）` },
      { label: '30天窗口', value: `${day(current.W30?.start)} → ${day(current.W30?.end)}` },
      { label: '时间口径', value: clean(windows.comparison_rule, 110) },
      { label: '30天粉丝净增', value: `${num(currentThirty.follower_net) ?? '—'} 人` },
    ],
  };
}

/** 会话5：规则与增长情报来源覆盖。 */
export function session5Insights(sources) {
  if (!isObject(sources)) return null;
  const coverage = isObject(sources.coverage) ? sources.coverage : {};
  const entries = list(sources.entries).filter(isObject);
  if (!entries.length && !Object.keys(coverage).length) return null;
  const limit = num(coverage.detail_sources_limit) ?? 12;
  const unique = num(coverage.unique_detail_sources_total) ?? entries.length;
  const categories = group(entries.map(row => row.category));
  return {
    kpis: [
      kpi('详情来源', unique, `/${limit}`),
      kpi('新开成功', num(coverage.new_detail_pages_opened_ok) ?? '—', '页'),
      kpi('打开失败', num(coverage.new_detail_pages_failed) ?? '—', '页'),
      kpi('情报条目', entries.length, '条'),
    ],
    charts: [
      { kind: 'donut', title: '条目类别', unit: '条', items: categories, center: { value: entries.length, unit: '条', label: '条目' } },
      {
        kind: 'bars', title: '采集覆盖', unit: '项', format: 'count', items: [
          { label: '新开成功', value: num(coverage.new_detail_pages_opened_ok) ?? 0 },
          { label: '复用已核', value: num(coverage.reused_prior_verified_sources) ?? 0 },
          { label: '打开失败', value: num(coverage.new_detail_pages_failed) ?? 0 },
          { label: '搜索查询', value: num(coverage.search_engines_queries) ?? 0 },
        ],
      },
      { kind: 'gauge', title: '来源上限使用', value: unique, max: Math.max(limit, 1), display: percent(unique / Math.max(limit, 1), 0), caption: `上限 ${limit} 个详情来源` },
    ],
    facts: [
      { label: '检索窗口', value: `${day(sources.window?.start)} → ${day(sources.window?.end)}（Asia/Shanghai）` },
      { label: '未做事项', value: list(sources.run?.not_done).slice(0, 2).join('；') || '—' },
      { label: '可信度标注', value: '官方原文、媒体转述、单案例与假设分开' },
    ],
  };
}

/** Dispatch one module to its pure builder. Unknown/empty input returns null. */
export function buildInsights(key, data, extras = {}) {
  switch (key) {
    case 'session1': return session1Insights(data);
    case 'session2': return session2Insights(data, extras);
    case 'session3': return session3Insights(data);
    case 'session4': return session4Insights(data);
    case 'session5': return session5Insights(data);
    default: return null;
  }
}
