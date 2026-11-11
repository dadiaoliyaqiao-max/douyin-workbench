/**
 * Pure report → slide-deck projection for the dashboard.
 *
 * Input is untrusted report text; output is plain data (strings/numbers) that the
 * React renderer writes as text nodes. Raw HTML is never interpreted here and
 * never reaches innerHTML. Video tables are excluded because the interactive
 * video library (cover + link + script selection) renders them instead.
 */

const LIST = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const HEADING = /^(#{1,4})\s+(.+?)\s*#*$/;
const FENCE = /^\s*(?:`{3,}|~{3,})/;
const TABLE_ROW = /\|/;
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const VIDEO_TABLE = /封面|作品ID|视频ID|点赞|评论/;
const IMAGE = /!\[([^\]]{0,120})\]\(<?([^)>\s]{1,240})>?\)/g;
const MAX_BULLETS = 6;
const MAX_TABLE_ROWS = 6;
const MAX_TABLE_COLS = 5;

/** Section images must be workspace-relative; external or absolute URLs never load. */
function safeImageSource(src) {
  const value = String(src ?? '').trim();
  if (!value || value.length > 240) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') || value.startsWith('\\')) return null;
  if (/[\\\0]/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return /\.(png|jpe?g|webp)$/i.test(value) ? value : null;
}

/** Collect at most three report-relative images from one Markdown line. */
export function imagesIn(text, limit = 3) {
  const found = [];
  if (typeof text !== 'string') return found;
  for (const match of text.matchAll(IMAGE)) {
    const src = safeImageSource(match[2]);
    if (!src || found.some(item => item.src === src)) continue;
    found.push({ alt: plain(match[1]) || '截图', src });
    if (found.length >= limit) break;
  }
  return found;
}

/** Flatten inline Markdown to plain text (links keep their label, images become 图). */
export function plain(value) {
  return String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, label) => (label ? `图：${label}` : '图'))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\\])[*_]{1,2}([^_*]+)\1?[*_]{1,2}/g, '$2')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One concise line for a slide; long paragraphs are trimmed with an ellipsis. */
export function condense(value, max = 90) {
  const output = plain(value);
  return output.length > max ? `${output.slice(0, max).trimEnd()}…` : output;
}

export function formatNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const absolute = Math.abs(value);
    if (absolute >= 1e8) return `${(value / 1e8).toFixed(2).replace(/\.0$/, '')}亿`;
    if (absolute >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
    return new Intl.NumberFormat('zh-CN').format(value);
  }
  return String(value ?? '—');
}

export function cellText(value) {
  return plain(value).replace(/\|/g, '／');
}

/** Split a Markdown report into a title, meta lines and H2/H3 sections. */
export function parseReport(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const result = { title: '', meta: [], sections: [] };
  let section = null;
  let paragraph = null;
  let fence = false;
  const pushSection = () => {
    paragraph = null;
    if (section && (section.bullets.length || section.paragraphs.length || section.tables.length || section.images.length)) result.sections.push(section);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (FENCE.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!line.trim()) { paragraph = null; continue; }
    const heading = line.match(HEADING);
    if (heading) {
      const level = heading[1].length;
      const title = plain(heading[2]);
      if (level === 1 && !result.title) { result.title = title; paragraph = null; continue; }
      if (level >= 2) {
        pushSection();
        section = { heading: title, bullets: [], paragraphs: [], tables: [], images: [], videoTable: false };
        continue;
      }
      // H3/H4 stay inside the current section as a compact sub-heading line.
      if (section) {
        section.paragraphs.push({ text: `▸ ${title}` });
        paragraph = null;
      } else if (result.meta.length < 6) result.meta.push(`▸ ${title}`);
      continue;
    }
    if (TABLE_ROW.test(line) && index + 1 < lines.length && SEPARATOR.test(lines[index + 1])) {
      const headers = splitRow(line);
      const videoTable = headers.some(cell => VIDEO_TABLE.test(cell));
      if (videoTable) result.videoTable = true;
      if (!section) { index = skipTable(lines, index); continue; }
      const rows = [];
      let cursor = index + 2;
      while (cursor < lines.length && TABLE_ROW.test(lines[cursor]) && !SEPARATOR.test(lines[cursor])) {
        rows.push(splitRow(lines[cursor]));
        cursor++;
      }
      if (videoTable) section.videoTable = true;
      else if (section.tables.length < 1) {
        section.tables.push({
          headers: headers.slice(0, MAX_TABLE_COLS).map(cellText),
          rows: rows.slice(0, MAX_TABLE_ROWS).map(row => row.slice(0, MAX_TABLE_COLS).map(cellText)),
          total: rows.length,
        });
      }
      index = cursor - 1;
      paragraph = null;
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      if (!section) { if (result.meta.length < 6) result.meta.push(condense(item[1], 80)); paragraph = null; continue; }
      section.bullets.push(condense(item[1], 96));
      for (const image of imagesIn(item[1])) if (!section.images.some(entry => entry.src === image.src)) section.images.push(image);
      paragraph = null;
      continue;
    }
    const text = line.replace(/^\s*>\s?/, '');
    if (!section) {
      if (result.meta.length < 6) result.meta.push(condense(text, 80));
      paragraph = null;
      continue;
    }
    for (const image of imagesIn(text)) if (!section.images.some(entry => entry.src === image.src)) section.images.push(image);
    if (paragraph) paragraph.text += ` ${text}`;
    else { paragraph = { text }; section.paragraphs.push(paragraph); }
  }
  pushSection();
  if (!result.title && result.sections.length) result.title = result.sections[0].heading;
  return result;
}

function skipTable(lines, index) {
  let cursor = index + 2;
  while (cursor < lines.length && TABLE_ROW.test(lines[cursor]) && !SEPARATOR.test(lines[cursor])) cursor++;
  return cursor - 1;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/** Project a report into deck slides. Charts come from the trusted server insight document. */
export function buildDeck(report) {
  const parsed = parseReport(report?.markdown);
  const insights = report?.insights;
  const slides = [{
    kind: 'cover',
    title: parsed.title || report?.title || '报告',
    meta: (Array.isArray(parsed.meta) ? parsed.meta : []).slice(0, 3),
    kpis: (Array.isArray(insights?.kpis) ? insights.kpis : []).slice(0, 4),
    updatedAt: report?.updatedAt || null,
    updatedAtSource: report?.updatedAtSource || null,
  }];
  if (Array.isArray(insights?.charts) && insights.charts.length) {
    slides.push({ kind: 'charts', title: '关键仪表盘', charts: insights.charts.slice(0, 4), facts: (Array.isArray(insights?.facts) ? insights.facts : []).slice(0, 4) });
  }
  for (const section of parsed.sections) {
    if (section.videoTable && !section.bullets.length && !section.paragraphs.length && !section.images.length) continue;
    slides.push({
      kind: 'section',
      heading: section.heading || parsed.title || '要点',
      bullets: section.bullets.slice(0, MAX_BULLETS),
      paragraphs: section.paragraphs.slice(0, 2).map(item => condense(item.text, 150)),
      tables: section.tables,
      images: section.images.slice(0, 2),
      more: Math.max(0, section.bullets.length - MAX_BULLETS),
    });
  }
  if (slides.length === 1) slides.push({ kind: 'section', heading: '报告内容', bullets: ['本报告暂无可用摘要，请切到“原文”查看完整内容。'], paragraphs: [], tables: [], images: [], more: 0 });
  return slides;
}
