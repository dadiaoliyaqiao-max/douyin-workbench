window.__ModuleLoader__.load({
  id: 'workspace-sidebar-dashboard',
  factory: (require) => {
    'use strict';
    /** Deliberately small Markdown renderer. Raw HTML and embedded media are never interpreted. */
    const MAX_RENDER_CHARS = 300_000;
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    
    /** Only explicit HTTPS destinations, without credentials or control characters. */
    function safeHttpsUrl(value) {
      if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\u0000-\u0020\u007f<>"'\\]/.test(value)) return null;
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : null;
      } catch { return null; }
    }
    
    function inline(value) {
      // Bounded tokens keep malformed markup bounded; no recursive parsing or HTML input.
      const tokens = /`[^`\n]{1,2000}`|\*\*[^*\n]{1,2000}\*\*|!?\[[^\]\n]{0,1000}\]\([^\s\n)]{1,2048}\)/g;
      let output = '', cursor = 0;
      for (const match of value.matchAll(tokens)) {
        output += escapeHtml(value.slice(cursor, match.index));
        const token = match[0];
        if (token.startsWith('`')) output += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
        else if (token.startsWith('**')) output += `<strong>${escapeHtml(token.slice(2, -2))}</strong>`;
        else {
          const image = token.startsWith('!');
          const separator = token.indexOf('](');
          const label = token.slice(image ? 2 : 1, separator);
          const target = token.slice(separator + 2, -1);
          const url = safeHttpsUrl(target);
          const text = escapeHtml(`${image ? '图片：' : ''}${label || target}`);
          output += url
            ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
            : `<span class="dsdash-unavailable-link" title="此链接不可直接打开">${text}（链接不可用）</span>`;
        }
        cursor = match.index + token.length;
      }
      return output + escapeHtml(value.slice(cursor));
    }
    
    function cells(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim());
    }
    const separatorRow = line => {
      const values = cells(line);
      return values.length > 0 && values.every(value => /^:?-{3,}:?$/.test(value));
    };
    
    /** Return only locally generated, escaped HTML. Relative/file/data/javascript links are inert. */
    function renderMarkdown(markdown) {
      const input = String(markdown ?? '');
      const lines = input.slice(0, MAX_RENDER_CHARS).replace(/\r\n?/g, '\n').split('\n');
      const output = [];
      for (let i = 0; i < lines.length;) {
        const line = lines[i];
        if (!line.trim()) { i++; continue; }
        if (/^\s*(`{3,}|~{3,})/.test(line)) {
          const fence = line.match(/^\s*(`{3,}|~{3,})/)[1];
          const code = [];
          i++;
          while (i < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i++]);
          if (i < lines.length) i++;
          output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
          continue;
        }
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        if (heading) { output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); i++; continue; }
        if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
        if (line.includes('|') && i + 1 < lines.length && separatorRow(lines[i + 1])) {
          const headers = cells(line);
          output.push(`<div class="dsdash-table-scroll"><table><thead><tr>${headers.map(value => `<th>${inline(value)}</th>`).join('')}</tr></thead><tbody>`);
          i += 2;
          while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
            output.push(`<tr>${cells(lines[i++]).map(value => `<td>${inline(value)}</td>`).join('')}</tr>`);
          }
          output.push('</tbody></table></div>');
          continue;
        }
        const list = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
        if (list) {
          const ordered = !list[1], tag = ordered ? 'ol' : 'ul';
          output.push(`<${tag}>`);
          while (i < lines.length) {
            const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(lines[i]);
            if (!item || !item[1] !== ordered) break;
            output.push(`<li>${inline(item[2])}</li>`); i++;
          }
          output.push(`</${tag}>`); continue;
        }
        if (/^>\s?/.test(line)) {
          const quote = [];
          while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(inline(lines[i++].replace(/^>\s?/, '')));
          output.push(`<blockquote>${quote.join('<br>')}</blockquote>`); continue;
        }
        output.push(`<p>${inline(line)}</p>`); i++;
      }
      if (input.length > MAX_RENDER_CHARS) output.push('<p class="dsdash-render-notice">预览内容过长，已截断；保存仍使用完整编辑内容。</p>');
      return output.join('\n');
    }
    
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
    function imagesIn(text, limit = 3) {
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
    function plain(value) {
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
    function condense(value, max = 90) {
      const output = plain(value);
      return output.length > max ? `${output.slice(0, max).trimEnd()}…` : output;
    }
    
    function formatNumber(value) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const absolute = Math.abs(value);
        if (absolute >= 1e8) return `${(value / 1e8).toFixed(2).replace(/\.0$/, '')}亿`;
        if (absolute >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
        return new Intl.NumberFormat('zh-CN').format(value);
      }
      return String(value ?? '—');
    }
    
    function cellText(value) {
      return plain(value).replace(/\|/g, '／');
    }
    
    /** Split a Markdown report into a title, meta lines and H2/H3 sections. */
    function parseReport(markdown) {
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
    function buildDeck(report) {
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
    
    const React = require('react');
    
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;
    const CONTROLLER = '{{CONTROLLER_SESSION_ID}}';
    const SCRIPT_SESSION = '{{SESSION3_ID}}';
    const CHANNEL = '/douyin-dashboard';
    const TYPE_ID = 'workspace-sidebar-dashboard/panel';
    const KIND = 'workspaceSidebarDashboard';
    const MODULES = [['session1', '对标账号'], ['session2', '参考视频'], ['session3', '原创剧本'], ['session4', '复盘'], ['session5', '情报']];
    const MODULE_META = {
      session1: { label: '对标账号', accent: '#5B8DEF' },
      session2: { label: '参考视频', accent: '#3EC6B5' },
      session3: { label: '原创剧本', accent: '#E8A33D' },
      session4: { label: '复盘', accent: '#EF7B7B' },
      session5: { label: '情报', accent: '#9B8CF0' },
    };
    const PALETTE = ['#5B8DEF', '#3EC6B5', '#F5B54B', '#EF7B7B', '#9B8CF0', '#7BC96F', '#5AC8E8', '#D99A5B'];
    const CATEGORY_LABEL = { benchmark: '对标账号', home: '家居家装', cross_industry: '跨行业热门', 自选: '自选' };
    const ABORTED = error => error?.name === 'AbortError';
    const messageOf = error => `${error?.code ? `${error.code}：` : ''}${error?.message || '请求失败，请重试'}`;
    const array = value => Array.isArray(value) ? value : [];
    const dateText = value => {
      if (!value) return '暂无日期';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '日期待核实' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    };
    const taskText = task => {
      if (!task) return '';
      if (typeof task === 'string') return task;
      const status = task.status || task.state || 'unknown';
      const labels = { accepted: '已接收，尚未完成', queued: '排队中', started: '已开始', running: '进行中', completed: '已完成', blocked: '已阻塞', failed: '失败', unknown: '状态待核实' };
      return labels[status] || String(status);
    };
    const notice = (text, kind = 'info') => text ? h('p', { className: `dsdash-notice dsdash-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text) : null;
    const button = (text, onClick, options = {}) => h('button', { type: 'button', onClick, ...options }, text);
    const clamp = (value, max) => typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value || '';
    
    const CSS = `
    .dsdash{font:13px/1.55 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-primary,#20242b);padding:16px;box-sizing:border-box;height:100%;overflow:auto}
    .dsdash *,.dsdash-dialog *{box-sizing:border-box}.dsdash button,.dsdash-dialog button{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#cbd2dc);border-radius:7px;padding:6px 11px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}.dsdash button:hover,.dsdash-dialog button:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f6)}.dsdash button:disabled,.dsdash-dialog button:disabled{cursor:default;opacity:.55}.dsdash button:focus-visible,.dsdash-dialog button:focus-visible,.dsdash-dialog select:focus-visible,.dsdash-dialog textarea:focus-visible{outline:2px solid #5279cf;outline-offset:2px}
    .dsdash-toolbar,.dsdash-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsdash-toolbar{justify-content:space-between}.dsdash-toolbar h2{font-size:17px;margin:0}.dsdash-muted{font-size:12px;color:var(--dsw-alias-label-secondary,#626b79)}.dsdash-cards{display:grid;gap:12px;margin-top:14px}.dsdash-card{border:1px solid var(--dsw-alias-border-l2,#d7dde7);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-1,#fff);position:relative;overflow:hidden}.dsdash-card:before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--accent,#5B8DEF)}.dsdash-card h3{font-size:15px;margin:0 0 6px;display:flex;align-items:center;gap:8px}.dsdash-card p{margin:5px 0;overflow-wrap:anywhere}.dsdash-card .dsdash-actions{margin-top:10px}.dsdash-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2f9;color:#3d4a63;font-weight:500}.dsdash-pill.done{background:#e6f4ee;color:#267a55}.dsdash-pill.busy{background:#fdf1d9;color:#8a6413}.dsdash-pill.fail{background:#fbe7e7;color:#9c3b3b}
    .dsdash-notice{margin:9px 0;padding:9px 11px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f0f3f8);overflow-wrap:anywhere}.dsdash-error{border-left:3px solid #cc5454}.dsdash-success{border-left:3px solid #398564}
    .dsdash-overlay{position:fixed;inset:0;z-index:1200;background:rgba(14,18,28,.62);display:flex;justify-content:center;align-items:center;padding:18px}.dsdash-dialog{font:14px/1.6 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-label-primary,#20242b);background:var(--dsw-alias-bg-layer-2,#eef1f6);width:min(1500px,97vw);height:96vh;border:1px solid var(--dsw-alias-border-l2,#d7dde7);border-radius:14px;box-shadow:0 22px 90px #0006;display:flex;flex-direction:column;overflow:hidden}
    .dsdash-dialog-header{padding:13px 20px;border-bottom:1px solid var(--dsw-alias-border-l2,#d7dde7);flex:none;background:var(--dsw-alias-bg-layer-1,#fff)}.dsdash-dialog-header h2{font-size:18px;margin:0}.dsdash-dialog-header select{font:inherit;max-width:min(560px,100%);padding:6px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;border:1px solid var(--dsw-alias-border-l2,#cbd2dc);border-radius:6px}
    .dsdash-dialog-body{overflow:auto;flex:1;min-height:0;padding:18px 22px 26px}.dsdash-viewtabs{display:flex;gap:6px}.dsdash-viewtabs button.active{background:var(--dsw-alias-bg-layer-1,#fff);border-color:#7d94bd;box-shadow:inset 0 0 0 1px #7d94bd;font-weight:600}
    .dsdash-slide{--accent:#5B8DEF;width:min(1120px,100%);margin:0 auto 16px;min-height:300px;padding:28px 34px;border-radius:16px;background:linear-gradient(180deg,#ffffff 0%,#fbfcff 100%);box-shadow:0 10px 34px rgba(24,34,52,.10);overflow:hidden;display:flex;flex-direction:column;position:relative}
    .dsdash-slide:after{content:'';position:absolute;left:0;top:0;bottom:0;width:6px;background:var(--accent)}
    .dsdash-slide-cover{min-height:440px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 16%,#ffffff) 0%,#ffffff 62%);color:#1b2432}
    .dsdash-slide-charts{min-height:560px}
    .dsdash-slide-tag{display:flex;justify-content:space-between;align-items:center;font-size:12px;letter-spacing:.06em;color:#5b6980;text-transform:uppercase}.dsdash-slide-tag strong{color:var(--accent);font-weight:700}
    .dsdash-slide-cover h2{font-size:clamp(20px,2.1vw,30px);line-height:1.25;margin:14px 0 8px;max-width:92%}
    .dsdash-slide-meta p{margin:3px 0;font-size:12.5px;color:#4a566c}
    .dsdash-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:auto;padding-top:18px}
    .dsdash-kpi{background:#fff;border:1px solid #e3e9f2;border-radius:12px;padding:11px 13px;min-width:0}.dsdash-kpi-value{display:block;font-size:24px;font-weight:700;color:#1b2432;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsdash-kpi-value small{font-size:12px;font-weight:500;color:#67758c;margin-left:2px}.dsdash-kpi-label{display:block;font-size:12px;color:#67758c;margin-top:2px}.dsdash-kpi-hint{display:block;font-size:11px;color:#8b96a8;margin-top:2px}
    .dsdash-slide h3.dsdash-slide-title{font-size:22px;margin:0 0 16px;padding-left:12px;border-left:5px solid var(--accent);line-height:1.3}
    .dsdash-slide-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:14px}
    .dsdash-bullets{margin:0;padding:0;list-style:none;display:grid;gap:10px}.dsdash-bullets li{position:relative;padding-left:16px;font-size:14.5px;line-height:1.7;color:#2b3548}.dsdash-bullets li:before{content:'';position:absolute;left:0;top:10px;width:6px;height:6px;border-radius:50%;background:var(--accent)}
    .dsdash-slide-more{font-size:12px;color:#7b879b}
    .dsdash-slide-para{margin:0;font-size:13.5px;color:#4a566c;line-height:1.75}
    .dsdash-slide-footer{font-size:11px;color:#8b96a8;margin-top:8px}
    .dsdash-slide-images{display:flex;gap:10px;flex:none}.dsdash-slide-images figure{margin:0;flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.dsdash-slide-images img{width:100%;max-height:150px;object-fit:cover;object-position:top;border:1px solid #e3e9f2;border-radius:8px;background:#f4f7fb}.dsdash-slide-images figcaption{font-size:10.5px;color:#7b879b;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:center}
    .dsdash-slidetable{width:100%;border-collapse:collapse;font-size:12px}.dsdash-slidetable th,.dsdash-slidetable td{border-bottom:1px solid #e6ebf3;padding:4px 6px;text-align:left;vertical-align:top}.dsdash-slidetable th{color:#5b6980;font-weight:600;background:#f7f9fc}
    .dsdash-chartgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;flex:1;min-height:0;grid-auto-rows:minmax(0,1fr)}
    .dsdash-chart{background:#fff;border:1px solid #e3e9f2;border-radius:12px;padding:10px 12px;min-height:0;overflow:hidden;display:flex;flex-direction:column}
    .dsdash-chart h4{margin:0 0 6px;font-size:12.5px;color:#41506a;font-weight:600}
    .dsdash-chart-main{flex:1;min-height:0;display:flex;align-items:center;gap:14px}
    .dsdash-donut{position:relative;width:132px;height:132px;flex:none}.dsdash-donut-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none}.dsdash-donut-center b{font-size:18px;line-height:1.1}.dsdash-donut-center span{font-size:10.5px;color:#7b879b}
    .dsdash-legend{margin:0;padding:0;list-style:none;display:grid;gap:4px;font-size:11.5px;min-width:0}.dsdash-legend li{display:flex;align-items:center;gap:6px;min-width:0}.dsdash-legend i{width:8px;height:8px;border-radius:2px;flex:none}.dsdash-legend span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsdash-legend b{margin-left:auto;font-weight:600;color:#2b3548}
    .dsdash-bars{display:grid;gap:5px;width:100%}.dsdash-bar-row{display:grid;grid-template-columns:52px 1fr auto;gap:7px;align-items:center;font-size:11.5px}.dsdash-bar-label{color:#5b6980;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsdash-bar-track{height:9px;border-radius:5px;background:#eef2f8;overflow:hidden}.dsdash-bar-fill{height:100%;border-radius:5px;background:var(--accent)}.dsdash-bar-value{font-variant-numeric:tabular-nums;color:#2b3548;font-weight:600}
    .dsdash-compare{display:grid;gap:6px;width:100%}.dsdash-compare-row{display:grid;grid-template-columns:64px 1fr auto;gap:7px;align-items:center;font-size:11.5px}.dsdash-compare-bars{display:grid;gap:2px}.dsdash-compare-bars i{display:block;height:6px;border-radius:3px}.dsdash-compare-bars .now{background:var(--accent)}.dsdash-compare-bars .prev{background:#cfd8e6}.dsdash-compare-value{font-variant-numeric:tabular-nums;font-weight:600;color:#2b3548;text-align:right}
    .dsdash-gauge{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;width:100%}.dsdash-gauge-value{font-size:20px;font-weight:700;margin-top:-14px}.dsdash-gauge-caption{font-size:10.5px;color:#7b879b;text-align:center;max-width:200px}
    .dsdash-facts{margin:8px 0 0;display:grid;gap:3px;font-size:11.5px;color:#5b6980}.dsdash-facts div{display:flex;gap:8px}.dsdash-facts dt{color:#8b96a8;flex:none}.dsdash-facts dd{margin:0;color:#3d4a63}
    .dsdash-report{overflow-wrap:anywhere;max-width:1100px;margin:0 auto;background:#fff;border-radius:14px;padding:22px 28px}.dsdash-report h1{font-size:26px}.dsdash-report h2{font-size:22px}.dsdash-report h3{font-size:18px}.dsdash-report p{margin:10px 0}.dsdash-report pre{white-space:pre-wrap;padding:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f0f3f8)}.dsdash-report code{font-family:ui-monospace,Consolas,monospace;white-space:pre-wrap}.dsdash-report blockquote{border-left:3px solid #8da3c9;margin:14px 0;padding-left:15px}.dsdash-table-scroll{overflow:auto}.dsdash-report table{border-collapse:collapse;min-width:100%;font-size:13px}.dsdash-report th,.dsdash-report td{border:1px solid var(--dsw-alias-border-l2,#d7dde7);padding:8px;vertical-align:top;min-width:85px}.dsdash-report a,.dsdash-videos a{color:var(--dsw-alias-link-primary,#3266be)}.dsdash-unavailable-link{color:var(--dsw-alias-label-secondary,#626b79)}
    .dsdash-editor-grid{display:grid;grid-template-columns:minmax(320px,1fr) minmax(320px,1.1fr);gap:18px;align-items:start}.dsdash-editor textarea{font:13px/1.7 ui-monospace,Consolas,monospace;resize:vertical;width:100%;min-height:60vh;padding:12px;border:1px solid var(--dsw-alias-border-l2,#cbd2dc);border-radius:10px;background:#fff;color:inherit}.dsdash-preview-scroll{max-height:72vh;overflow:auto;padding:4px}
    .dsdash-library{margin:8px auto 0;width:min(1120px,100%)}.dsdash-library-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin:0 0 10px}.dsdash-library-head h3{font-size:17px;margin:0}.dsdash-filters{display:flex;gap:6px;flex-wrap:wrap}.dsdash-filters button{border-radius:999px;padding:4px 12px;font-size:12px}.dsdash-filters button.active{background:#e8eefb;border-color:#9cb3dd;font-weight:600}
    .dsdash-videos{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:12px}.dsdash-video{display:flex;flex-direction:column;background:#fff;border:1px solid #e3e9f2;border-radius:12px;overflow:hidden;box-shadow:0 4px 14px rgba(24,34,52,.05)}.dsdash-cover{position:relative;display:block;aspect-ratio:4/3;background:linear-gradient(135deg,#e8eef8,#f6f8fc);overflow:hidden}.dsdash-cover img{width:100%;height:100%;object-fit:contain;display:block;background:#eef2f8}.dsdash-cover-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;color:#9aa8bd}.dsdash-badge{position:absolute;left:8px;top:8px;background:rgba(17,24,38,.72);color:#fff;font-size:11px;font-weight:600;padding:2px 7px;border-radius:6px;letter-spacing:.03em}.dsdash-video-body{padding:9px 11px 11px;display:flex;flex-direction:column;gap:4px;flex:1}.dsdash-video-body h4{margin:0;font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:35px}.dsdash-video-meta{margin:0;font-size:11.5px;color:#67758c;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsdash-video-reason{margin:2px 0 0;font-size:11.5px;line-height:1.4;color:#4a566c;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.dsdash-video-metrics{margin:0;font-size:11.5px;color:#41506a;font-variant-numeric:tabular-nums}.dsdash-video-actions{display:flex;gap:7px;margin-top:auto;padding-top:6px;flex-wrap:wrap}.dsdash-link-button{flex:1;min-width:72px;display:inline-flex;align-items:center;justify-content:center;gap:4px;text-decoration:none;font-size:12px;padding:5px 9px;border:1px solid #cbd2dc;border-radius:7px;color:#2b3548;background:#fff}.dsdash-link-button:hover{background:#eef1f6}.dsdash-dive-button{flex:1;min-width:72px;font-size:12px;padding:5px 9px;background:#fff;color:#22314d;border-color:#9fb0cc;font-weight:600}.dsdash-dive-button:hover{background:#eef2fa}.dsdash-dive-button:disabled{opacity:.55}.dsdash-write-button{flex:1;min-width:96px;font-size:12px;padding:5px 9px;background:#22314d;color:#fff;border-color:#22314d}.dsdash-write-button:hover{background:#2e4166}.dsdash-write-button:disabled{background:#9aa8bd;border-color:#9aa8bd;color:#fff}
    .dsdash-history{margin:16px auto 0;width:min(1120px,100%);background:#fff;border:1px solid #e3e9f2;border-radius:10px;padding:10px 14px;font-size:12.5px}
    .dsdash-accounts .dsdash-account{cursor:pointer}.dsdash-accounts .dsdash-account:hover{border-color:#9fb0cc;box-shadow:0 6px 18px rgba(24,34,52,.12)}.dsdash-account-detail{display:grid;grid-template-columns:minmax(280px,420px) 1fr;gap:18px;align-items:start;background:#fff;border:1px solid #e3e9f2;border-radius:12px;padding:14px}.dsdash-account-shot{width:100%;max-height:540px;object-fit:contain;background:#eef2f8;border-radius:10px;border:1px solid #e3e9f2}.dsdash-account-info h4{margin:12px 0 6px}.dsdash-account-videos{margin:0;padding-left:18px;display:grid;gap:6px;font-size:12.5px;max-height:420px;overflow:auto}.dsdash-account-videos a{color:#3266be}
    .dsdash-account-analysis{grid-column:1/-1;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:10px;padding:12px 14px;font-size:12.8px;line-height:1.6;max-height:320px;overflow:auto}.dsdash-account-analysis h3,.dsdash-account-analysis h4{margin:8px 0 4px;font-size:13.5px}.dsdash-account-analysis p{margin:6px 0}.dsdash-account-analysis ul{margin:4px 0;padding-left:18px}.dsdash-account-analysis table{border-collapse:collapse;font-size:12px}.dsdash-account-analysis th,.dsdash-account-analysis td{border:1px solid #dfe6f0;padding:3px 6px}
    .dsdash-dive-overlay{z-index:1300}.dsdash-dive-panel{width:min(1000px,94vw);height:90vh}.dsdash-dive-checks{margin:10px 0;padding:10px 12px;background:#f7f9fc;border:1px solid #e3e9f2;border-radius:8px;font-size:12.5px}.dsdash-dive-checks h4{margin:0 0 6px;font-size:13px}.dsdash-dive-checks ul{margin:0;padding-left:18px}.dsdash-dive-limits{margin:8px 0;padding-left:18px;font-size:12px;color:#6b7789}.dsdash-dive-transcript{margin:10px 0;padding:12px;background:#fff;border:1px solid #e3e9f2;border-radius:8px;max-height:340px;overflow:auto}.dsdash-dive-transcript h4{margin:0 0 8px;font-size:13px}.dsdash-dived{background:#e8f5ec;border-color:#9fd3ad;color:#1d6b34}.dsdash-dived:hover{background:#ddf0e3}
    .dsdash-transcript{background:#fff;border:1px solid #e3e9f2;border-radius:10px;padding:10px 14px;margin:10px 0}.dsdash-transcript summary{cursor:pointer;font-weight:600;font-size:13.5px}.dsdash-transcript-body{margin-top:10px;max-height:420px;overflow:auto;border-top:1px solid #eef2f8;padding-top:10px}.dsdash-transcript-reviewed{margin-top:10px;border-top:1px dashed #dbe3ee;padding-top:8px}.dsdash-transcript-reviewed summary{cursor:pointer;font-weight:600;font-size:12.5px}
    .dsdash-script-panel{width:min(720px,92vw);height:auto;max-height:86vh}.dsdash-script-label{display:block;font-size:13px;font-weight:600;margin:10px 0 6px}.dsdash-script-input{width:100%;font:13px/1.6 ui-monospace,Consolas,monospace;padding:10px;border:1px solid #cbd2dc;border-radius:8px;resize:vertical;background:#fff;color:inherit}.dsdash-dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}.dsdash-deck-actions{display:flex;justify-content:center;margin:4px 0 18px}.dsdash-deck-actions button.dsdash-write-button{background:#2563eb;border-color:#2563eb;color:#fff}.dsdash-deck-actions button.dsdash-write-button:hover:not(:disabled){background:#1d4ed8 !important;border-color:#1d4ed8 !important;color:#fff !important}.dsdash-script-panel .dsdash-dialog-actions button.dsdash-write-button{background:#2563eb;border-color:#2563eb;color:#fff}.dsdash-script-panel .dsdash-dialog-actions button.dsdash-write-button:hover:not(:disabled){background:#1d4ed8 !important;border-color:#1d4ed8 !important;color:#fff !important}.dsdash-script-panel .dsdash-dialog-actions button.dsdash-write-button:disabled{background:#9aa8bd;border-color:#9aa8bd;color:#fff;cursor:not-allowed}
    @keyframes dsdash-fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}.dsdash-slide{animation:dsdash-fade .22s ease}
    @media(max-width:900px){.dsdash-overlay{padding:4px}.dsdash-dialog{height:99vh;width:100%;border-radius:10px}.dsdash-dialog-body{padding:10px}.dsdash-editor-grid{grid-template-columns:1fr}.dsdash-kpis{grid-template-columns:1fr 1fr}.dsdash-chartgrid{grid-template-columns:1fr}.dsdash-slide{min-height:0;padding:18px}.dsdash-slide-cover,.dsdash-slide-charts{min-height:0}.dsdash-dialog-header{padding:10px}.dsdash-dialog-header h2{font-size:16px}.dsdash-account-detail{grid-template-columns:1fr}}
    `;
    
    /** Only this renderer's escaped output reaches innerHTML; never raw report HTML. */
    function Markdown({ value }) {
      const html = useMemo(() => renderMarkdown(value), [value]);
      return h('article', { className: 'dsdash-report', dangerouslySetInnerHTML: { __html: html } });
    }
    
    const chartValue = (value, format, unit) => {
      if (format === 'rate') return `${value}%`;
      const base = formatNumber(value);
      return unit ? `${base}${unit}` : base;
    };
    
    function Donut({ chart, items, accent }) {
      const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
      if (!total) return h('p', { className: 'dsdash-muted' }, '暂无数据');
      let offset = 0;
      const radius = 42, circumference = 2 * Math.PI * radius;
      const segments = items.map((item, index) => {
        const share = Math.max(0, item.value) / total;
        const dash = `${share * circumference} ${circumference - share * circumference}`;
        const circle = h('circle', {
          key: index, cx: 66, cy: 66, r: radius, fill: 'none', stroke: PALETTE[index % PALETTE.length],
          strokeWidth: 18, strokeDasharray: dash, strokeDashoffset: -offset, transform: 'rotate(-90 66 66)',
        });
        offset += share * circumference;
        return circle;
      });
      return h('div', { className: 'dsdash-chart-main' },
        h('div', { className: 'dsdash-donut' }, h('svg', { viewBox: '0 0 132 132', width: 132, height: 132, role: 'img', 'aria-label': chart.title },
          h('circle', { cx: 66, cy: 66, r: radius, fill: 'none', stroke: '#eef2f8', strokeWidth: 18 }), ...segments),
          h('div', { className: 'dsdash-donut-center' }, h('b', { style: { color: accent } }, formatNumber(chart.center?.value ?? total)), h('span', null, chart.center?.label || '合计'))),
        h('ul', { className: 'dsdash-legend' }, ...items.map((item, index) => h('li', { key: index },
          h('i', { style: { background: PALETTE[index % PALETTE.length] } }), h('span', { title: item.label }, item.label), h('b', null, chartValue(item.value, chart.format, chart.unit))))));
    }
    
    function Bars({ chart, items, accent }) {
      const max = Math.max(1, ...items.map(item => Math.abs(item.value)));
      return h('div', { className: 'dsdash-bars' }, ...items.map((item, index) => h('div', { className: 'dsdash-bar-row', key: index, title: item.hint || item.label },
        h('span', { className: 'dsdash-bar-label' }, item.label),
        h('div', { className: 'dsdash-bar-track' }, h('div', { className: 'dsdash-bar-fill', style: { width: `${Math.max(2, Math.abs(item.value) / max * 100)}%`, background: PALETTE[index % PALETTE.length] || accent } })),
        h('span', { className: 'dsdash-bar-value' }, chartValue(item.value, chart.format, chart.unit)))));
    }
    
    function Gauge({ chart, accent }) {
      const max = chart.max > 0 ? chart.max : 1;
      const ratio = Math.max(0, Math.min(1, (chart.value || 0) / max));
      const length = Math.PI * 46;
      return h('div', { className: 'dsdash-gauge' },
        h('svg', { viewBox: '0 0 120 70', width: 168, height: 98, role: 'img', 'aria-label': chart.title },
          h('path', { d: 'M 14 60 A 46 46 0 0 1 106 60', fill: 'none', stroke: '#eef2f8', strokeWidth: 12, strokeLinecap: 'round' }),
          h('path', { d: 'M 14 60 A 46 46 0 0 1 106 60', fill: 'none', stroke: accent, strokeWidth: 12, strokeLinecap: 'round', strokeDasharray: `${ratio * length} ${length}` })),
        h('span', { className: 'dsdash-gauge-value' }, chart.display || chartValue(chart.value, chart.format, chart.unit)),
        chart.caption ? h('span', { className: 'dsdash-gauge-caption' }, chart.caption) : null);
    }
    
    function Compare({ chart, items, accent }) {
      const show = (value, item) => item.format === 'rate' ? `${value ?? '—'}%` : `${formatNumber(value)}${item.unit || ''}`;
      const max = Math.max(1, ...items.flatMap(item => [Math.abs(item.current ?? 0), Math.abs(item.previous ?? 0)]));
      return h('div', { className: 'dsdash-compare' }, ...items.map((item, index) => h('div', { className: 'dsdash-compare-row', key: index, title: `${item.label}：本期 ${show(item.current, item)}｜上期 ${show(item.previous, item)}` },
        h('span', { className: 'dsdash-bar-label' }, item.label),
        h('div', { className: 'dsdash-compare-bars' },
          h('i', { className: 'now', style: { width: `${Math.max(2, Math.abs(item.current ?? 0) / max * 100)}%`, background: PALETTE[index % PALETTE.length] || accent } }),
          h('i', { className: 'prev', style: { width: `${Math.max(2, Math.abs(item.previous ?? 0) / max * 100)}%` } })),
        h('span', { className: 'dsdash-compare-value' }, show(item.current, item), h('br'), h('span', { className: 'dsdash-muted' }, `上期 ${show(item.previous, item)}`)))));
    }
    
    function ChartCard({ chart, accent }) {
      const items = array(chart?.items).filter(item => item && typeof item.label === 'string' && Number.isFinite(item.value));
      const compare = array(chart?.items).filter(item => item && typeof item.label === 'string');
      let main = null;
      if (chart.kind === 'donut' && items.length) main = h(Donut, { chart, items, accent });
      else if (chart.kind === 'bars' && items.length) main = h(Bars, { chart, items, accent });
      else if (chart.kind === 'gauge') main = h(Gauge, { chart, accent });
      else if (chart.kind === 'compare' && compare.length) main = h(Compare, { chart, items: compare, accent });
      return h('div', { className: 'dsdash-chart' }, h('h4', null, chart.title || '图表'), main || h('p', { className: 'dsdash-muted' }, '暂无数据'));
    }
    
    function Slide({ slide, accent, moduleLabel, reportId }) {
      if (slide.kind === 'cover') {
        return h('section', { className: 'dsdash-slide dsdash-slide-cover', style: { '--accent': accent } },
          h('div', { className: 'dsdash-slide-tag' }, h('strong', null, moduleLabel), h('span', null, `更新：${dateText(slide.updatedAt)}`)),
          h('h2', null, slide.title),
          slide.meta.length ? h('div', { className: 'dsdash-slide-meta' }, ...slide.meta.map((line, index) => h('p', { key: index }, line))) : null,
          slide.kpis.length ? h('div', { className: 'dsdash-kpis' }, ...slide.kpis.map((kpi, index) => h('div', { className: 'dsdash-kpi', key: index },
            h('span', { className: 'dsdash-kpi-value' }, kpi.value, kpi.unit ? h('small', null, kpi.unit) : null),
            h('span', { className: 'dsdash-kpi-label' }, kpi.label),
            kpi.hint ? h('span', { className: 'dsdash-kpi-hint' }, kpi.hint) : null))) : null,
          h('div', { className: 'dsdash-slide-footer' }, 'PPT 演示视图 · 数字来自报告与元数据，不改写原文'));
      }
      if (slide.kind === 'charts') {
        return h('section', { className: 'dsdash-slide dsdash-slide-charts', style: { '--accent': accent } },
          h('h3', { className: 'dsdash-slide-title' }, slide.title),
          h('div', { className: 'dsdash-chartgrid' }, ...slide.charts.map((chart, index) => h(ChartCard, { key: index, chart, accent }))),
          slide.facts.length ? h('div', { className: 'dsdash-facts' }, ...slide.facts.map((fact, index) => h('div', { key: index }, h('dt', null, fact.label), h('dd', null, fact.value)))) : null,
          h('div', { className: 'dsdash-slide-footer' }, '图表由结构化元数据生成；候选/样本数量不代表已完成验收'));
      }
      return h('section', { className: 'dsdash-slide', style: { '--accent': accent } },
        h('h3', { className: 'dsdash-slide-title' }, slide.heading),
        h('div', { className: 'dsdash-slide-body' },
          slide.images.length ? h('div', { className: 'dsdash-slide-images' }, ...slide.images.map((image, index) => h('figure', { key: index },
            h('img', { src: assetUrl(reportId, image.src), alt: image.alt, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' }),
            h('figcaption', null, image.alt)))) : null,
          slide.bullets.length ? h('ul', { className: 'dsdash-bullets' }, ...slide.bullets.map((line, index) => h('li', { key: index }, line))) : null,
          slide.paragraphs.length ? h('div', null, ...slide.paragraphs.map((line, index) => h('p', { className: 'dsdash-slide-para', key: index }, line))) : null,
          slide.tables.length ? h('table', { className: 'dsdash-slidetable' }, h('thead', null, h('tr', null, ...slide.tables[0].headers.map((cell, index) => h('th', { key: index }, cell)))), h('tbody', null, ...slide.tables[0].rows.map((row, index) => h('tr', { key: index }, ...row.map((cell, cellIndex) => h('td', { key: cellIndex }, cell)))))) : null,
          slide.more ? h('p', { className: 'dsdash-slide-more' }, `另有 ${slide.more} 条要点，切换“原文”查看完整报告`) : null),
        h('div', { className: 'dsdash-slide-footer' }, '精简自报告原文；完整措辞见“原文”'));
    }
    
    const assetUrl = (reportId, src) => `/api/douyin-asset?reportId=${encodeURIComponent(reportId)}&path=${encodeURIComponent(src)}`;
    
    /** Split Markdown on H2 headings for the compact script deck. */
    function splitSections(markdown) {
      const sections = [];
      let current = null;
      for (const line of String(markdown || '').split(/\r?\n/)) {
        const heading = line.match(/^##\s+(.+)$/);
        if (heading) { current = { heading: heading[1].trim(), lines: [] }; sections.push(current); continue; }
        if (current) current.lines.push(line);
      }
      return sections.map(section => ({ heading: section.heading, body: section.lines.join('\n').trim() })).filter(section => section.body);
    }
    
    // 原创剧本演示只保留：具体剧本（分镜）、口播文案、标题、封面建议。
    const CN_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    function ScriptDeck({ report, onAdjust }) {
      const meta = MODULE_META[report.key] || MODULE_META.session3;
      const sections = useMemo(() => splitSections(report.markdown).filter(section => /剧本|分镜|口播|标题|封面/.test(section.heading)), [report]);
      if (!sections.length) return notice('本剧本报告没有“剧本/口播/标题/封面”章节，演示已省略其他内容。');
      return h('div', { className: 'dsdash-deck' }, ...sections.map((section, index) => h('section', { key: index, className: 'dsdash-slide', style: { '--accent': meta.accent } },
        h('div', { className: 'dsdash-slide-tag' }, h('span', null, meta.label), h('strong', null, '原创剧本')),
        h('h3', { className: 'dsdash-slide-title' }, `${CN_NUMBERS[index] || index + 1}、${section.heading.replace(/^[一二三四五六七八九十]+[、.．]\s*/, '')}`),
        h('div', { className: 'dsdash-slide-body' }, h(Markdown, { value: section.body })))),
      onAdjust ? h('div', { className: 'dsdash-deck-actions' }, button('调整剧本', onAdjust, { className: 'dsdash-write-button' })) : null);
    }
    
    function AdjustScriptDialog({ text, busy, onChange, onClose, onSubmit }) {
      const [hint, setHint] = useState('');
      const submit = () => {
        if (!text.trim()) { setHint('请先填写本次调整要求'); return; }
        setHint('');
        onSubmit();
      };
      return h('div', { className: 'dsdash-overlay dsdash-dive-overlay' }, h('section', { className: 'dsdash-dialog dsdash-script-panel', role: 'dialog', 'aria-modal': true, 'aria-label': '调整剧本', tabIndex: -1 },
        h('header', { className: 'dsdash-dialog-header' }, h('div', { className: 'dsdash-toolbar' },
          h('h2', null, '调整剧本'), button('关闭', onClose))),
        h('div', { className: 'dsdash-dialog-body' },
          h('label', { className: 'dsdash-script-label' }, '本次调整要求（会派给原会话3，基于当前剧本生成新版本；不覆盖旧版本）'),
          h('textarea', { className: 'dsdash-script-input', rows: 6, maxLength: 2000, value: text, placeholder: '例如：口播缩短到30秒；开头改成预算痛点；标题更口语；封面换成“插座清单”大字。', onChange: event => onChange(event.target.value) }),
          h('p', { className: 'dsdash-muted' }, `${text.trim().length}/2000 字`),
          hint ? notice(hint, 'error') : null,
          h('div', { className: 'dsdash-dialog-actions' },
            button('取消', onClose),
            button(busy ? '提交中…' : '提交调整', submit, { className: 'dsdash-write-button', disabled: busy })))));
    }
    
    function Deck({ report, filterHeading, afterHeading, afterSlide }) {
      const meta = MODULE_META[report.key] || MODULE_META.session1;
      const slides = useMemo(() => {
        const all = buildDeck(report);
        return filterHeading ? all.filter(slide => !filterHeading.test(slide.heading || slide.title || '')) : all;
      }, [report, filterHeading]);
      return h('div', { className: 'dsdash-deck' }, ...slides.map((slide, index) => h(React.Fragment, { key: index },
        h(Slide, { slide, accent: meta.accent, moduleLabel: meta.label, reportId: report.id }),
        afterHeading && afterHeading.test(slide.heading || '') ? afterSlide : null)));
    }
    
    function VideoLibrary({ report, videoStates, deepStates, onCreate, onDive, onViewDive, disabled, openSession, confirmLeave }) {
      const videos = array(report.videos);
      const [filter, setFilter] = useState('all');
      if (!videos.length) return h('section', { className: 'dsdash-library' }, h('div', { className: 'dsdash-library-head' }, h('h3', null, '参考视频库')), notice('本报告没有可索引的视频条目。'));
      const categories = [...new Set(videos.map(video => video.category).filter(Boolean))];
      const shown = filter === 'all' ? videos : videos.filter(video => video.category === filter);
      const covered = videos.filter(video => video.coverUrl).length;
      return h('section', { className: 'dsdash-library' },
        h('div', { className: 'dsdash-library-head' },
          h('div', null, h('h3', null, `参考视频库 · ${videos.length} 条`), h('p', { className: 'dsdash-muted' }, `真实封面 ${covered}/${videos.length}；点封面或“查看视频”直达原视频；点“拆解”派给会话2做全片结构与评论拆解；点“做原创剧本”选片（服务端仍会核验交接）。`)),
          h('div', { className: 'dsdash-filters' },
            h('button', { type: 'button', className: filter === 'all' ? 'active' : '', onClick: () => setFilter('all') }, `全部 ${videos.length}`),
            ...categories.map(category => h('button', { key: category, type: 'button', className: filter === category ? 'active' : '', onClick: () => setFilter(category) }, `${CATEGORY_LABEL[category] || category} ${videos.filter(video => video.category === category).length}`)))),
        h('div', { className: 'dsdash-videos' }, ...shown.map(video => {
          const row = videoStates[video.videoId] || {};
          const dive = deepStates[video.videoId] || {};
          const url = safeHttpsUrl(video.url);
          const cover = typeof video.coverUrl === 'string' && video.coverUrl.startsWith('/api/douyin-cover?') ? video.coverUrl : null;
          const metrics = [video.likesDisplay || (Number.isFinite(video.likes) ? formatNumber(video.likes) : null), video.commentsDisplay || (Number.isFinite(video.comments) ? formatNumber(video.comments) : null)];
          return h('article', { className: 'dsdash-video', key: video.videoId },
            cover ? h('a', { className: 'dsdash-cover', href: url || '#', target: url ? '_blank' : undefined, rel: 'noopener noreferrer', 'aria-label': `查看原视频 ${video.code || video.videoId}` },
              h('img', { src: cover, alt: `${video.code || ''} 封面`, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' }),
              h('span', { className: 'dsdash-badge' }, video.code || video.videoId)) : h('div', { className: 'dsdash-cover' }, h('div', { className: 'dsdash-cover-empty' }, video.code || video.videoId), h('span', { className: 'dsdash-badge' }, video.code || video.videoId)),
            h('div', { className: 'dsdash-video-body' },
              h('h4', { title: video.title || '' }, video.title || '未命名视频'),
              h('p', { className: 'dsdash-video-meta' }, [video.account, video.publishedAt ? String(video.publishedAt).slice(0, 10) : null].filter(Boolean).join(' · ') || '账号/日期未记录'),
              video.reason ? h('p', { className: 'dsdash-video-reason', title: video.reason }, `入选原因：${video.reason}`) : null,
              h('p', { className: 'dsdash-video-metrics' }, metrics[0] || metrics[1] ? `赞 ${metrics[0] || '—'} · 评 ${metrics[1] || '—'}` : '互动数据未记录'),
              h('div', { className: 'dsdash-video-actions' },
                url ? h('a', { className: 'dsdash-link-button', href: url, target: '_blank', rel: 'noopener noreferrer' }, '查看视频') : h('span', { className: 'dsdash-muted' }, '链接不可用'),
                video.deepDived
                  ? button('已拆解', () => onViewDive(video), { className: 'dsdash-dive-button dsdash-dived' })
                  : button(dive.busy ? '拆解提交中…' : dive.done ? '已提交拆解' : dive.error ? '重试拆解' : '拆解', () => onDive(video), { className: 'dsdash-dive-button', disabled: disabled || dive.busy || dive.done }),
                button(row.busy ? '提交中…' : row.done ? '已提交' : row.error ? '重试创作' : '做原创剧本', () => onCreate(video), { className: 'dsdash-write-button', disabled: disabled || row.busy || row.done })),
              dive.text ? notice(dive.text, dive.error ? 'error' : 'info') : null,
              row.targetSessionId === SCRIPT_SESSION ? h('div', null, button('打开原会话3', () => { if (confirmLeave()) openSession(row.targetSessionId); })) : null,
              notice(row.text, row.error ? 'error' : 'info')));
        })));
    }
    
    function AccountLibrary({ report }) {
      const accounts = array(report.accounts);
      const [selectedId, setSelectedId] = useState(null);
      if (!accounts.length) return h('section', { className: 'dsdash-library' }, h('div', { className: 'dsdash-library-head' }, h('h3', null, '对标账号库')), notice('本报告没有可索引的账号卡片。'));
      const selected = accounts.find(account => account.accountId === selectedId) || null;
      const assetFor = file => `/api/douyin-asset?reportId=${encodeURIComponent(report.id)}&path=${encodeURIComponent(file)}`;
      if (selected) {
        return h('section', { className: 'dsdash-library' },
          h('div', { className: 'dsdash-library-head' },
            h('div', null, h('h3', null, selected.name), h('p', { className: 'dsdash-muted' }, `${selected.douyinId ? `抖音号 ${selected.douyinId} · ` : ''}${selected.fansDisplay ? `粉丝 ${selected.fansDisplay} · ` : ''}${selected.worksDisplay ? `作品 ${selected.worksDisplay}` : ''}`)),
            button('返回账号列表', () => setSelectedId(null))),
          h('div', { className: 'dsdash-account-detail' },
            selected.analysis ? h('div', { className: 'dsdash-account-analysis', dangerouslySetInnerHTML: { __html: renderMarkdown(selected.analysis) } }) : notice('本账号暂无文字分析内容。'),
            selected.profileImage ? h('img', { className: 'dsdash-account-shot', src: assetFor(selected.profileImage), alt: `${selected.name} 首页截图`, loading: 'lazy' }) : notice('该账号首页截图不可用。'),
            h('div', { className: 'dsdash-account-info' },
              h('p', { className: 'dsdash-muted' }, `截图时间：${dateText(selected.capturedAt)}`),
              h('p', null, `新增视频 ${selected.newVideoCount} 条 / 采样 ${selected.sampledVideoCount} 条；评论样本 ${selected.commentSamples} 条`),
              safeHttpsUrl(selected.profileUrl) ? h('a', { className: 'dsdash-link-button', href: safeHttpsUrl(selected.profileUrl), target: '_blank', rel: 'noopener noreferrer' }, '打开抖音主页') : h('span', { className: 'dsdash-muted' }, '主页链接不可用'),
              selected.commentNote ? h('p', { className: 'dsdash-muted' }, `评论说明：${selected.commentNote}`) : null,
              h('h4', null, `最近视频（${selected.videos.length}）`),
              selected.videos.length ? h('ul', { className: 'dsdash-account-videos' }, ...selected.videos.map(video => h('li', { key: video.videoId },
                safeHttpsUrl(video.url) ? h('a', { href: safeHttpsUrl(video.url), target: '_blank', rel: 'noopener noreferrer' }, video.title || video.videoId) : (video.title || video.videoId),
                h('span', { className: 'dsdash-muted' }, ` · ${video.publishedAt ? String(video.publishedAt).slice(0, 10) : '日期待核'}${video.likesDisplay ? ` · 赞 ${video.likesDisplay}` : ''}${video.commentsDisplay ? ` · 评 ${video.commentsDisplay}` : ''}${video.isNew ? ' · 新增' : ''}`)))) : h('p', { className: 'dsdash-muted' }, '本窗口无新增视频（零新增不等于停更）。'))));
      }
      return h('section', { className: 'dsdash-library' },
        h('div', { className: 'dsdash-library-head' },
          h('div', null, h('h3', null, `对标账号 · ${accounts.length} 个`), h('p', { className: 'dsdash-muted' }, '一个账号一张卡片；点卡片或“查看详情”看该账号首页截图、主页链接、最近新增视频与评论情况。'))),
        h('div', { className: 'dsdash-videos dsdash-accounts' }, ...accounts.map(account => h('article', { className: 'dsdash-video dsdash-account', key: account.accountId, role: 'button', tabIndex: 0, onClick: () => setSelectedId(account.accountId), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(account.accountId); } } },
          account.profileImage ? h('div', { className: 'dsdash-cover' }, h('img', { src: assetFor(account.profileImage), alt: `${account.name} 首页截图`, loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer' }), h('span', { className: 'dsdash-badge' }, account.douyinId || '对标账号'))
            : h('div', { className: 'dsdash-cover' }, h('div', { className: 'dsdash-cover-empty' }, '截图不可用')),
          h('div', { className: 'dsdash-video-body' },
            h('h4', { title: account.name }, account.name),
            h('p', { className: 'dsdash-video-meta' }, [account.douyinId ? `抖音号 ${account.douyinId}` : null, account.ipRegion].filter(Boolean).join(' · ') || '账号信息待核'),
            h('p', { className: 'dsdash-video-metrics' }, `新增 ${account.newVideoCount} 条 · 采样 ${account.sampledVideoCount} 条 · 评论样本 ${account.commentSamples}`),
            h('div', { className: 'dsdash-video-actions' },
              safeHttpsUrl(account.profileUrl) ? h('a', { className: 'dsdash-link-button', href: safeHttpsUrl(account.profileUrl), target: '_blank', rel: 'noopener noreferrer', onClick: event => event.stopPropagation() }, '打开主页') : null,
              button('查看详情', () => setSelectedId(account.accountId), { className: 'dsdash-write-button' })))))
      ));
    }
    
    function DeepDivePanel({ detail, onClose }) {
      const video = detail.video || {};
      const data = detail.data || null;
      const checks = data?.deepCheck && typeof data.deepCheck.checks === 'object' && data.deepCheck.checks ? Object.entries(data.deepCheck.checks) : [];
      return h('div', { className: 'dsdash-overlay dsdash-dive-overlay' }, h('section', { className: 'dsdash-dialog dsdash-dive-panel', role: 'dialog', 'aria-modal': true, 'aria-label': `${video.code || video.videoId} 拆解详情`, tabIndex: -1 },
        h('header', { className: 'dsdash-dialog-header' }, h('div', { className: 'dsdash-toolbar' },
          h('h2', null, `${video.code || video.videoId}｜${video.title || '拆解详情'}${data && data.revision !== null ? ` · revision-${data.revision}` : ''}`),
          button('关闭', onClose))),
        h('div', { className: 'dsdash-dialog-body' },
          detail.loading ? notice('正在读取拆解内容…') : detail.error ? notice(detail.error, 'error') : h(React.Fragment, null,
            data?.transcript ? h('p', { className: 'dsdash-muted' }, `逐字稿：${data.transcript.mode || '模式未记录'}；${data.transcript.returnType || '类型未记录'}；${data.transcript.claimsWatched ? '豆包声明看过视频' : '未声明看过视频'}`) : notice('该拆解未记录豆包逐字稿元数据。'),
            data?.transcript?.limitations?.length ? h('ul', { className: 'dsdash-dive-limits' }, ...data.transcript.limitations.map((line, index) => h('li', { key: index }, line))) : null,
            data?.transcriptRaw ? h('div', { className: 'dsdash-dive-transcript' },
              h('h4', null, '原始逐字稿（完整，豆包输出；AI辅助，未经真人审核）'),
              h(Markdown, { value: data.transcriptRaw })) : data?.transcriptReviewed ? h('div', { className: 'dsdash-dive-transcript' },
              h('h4', null, '修订稿（未找到原始输出）'),
              h(Markdown, { value: data.transcriptReviewed })) : notice('该拆解未保存逐字稿文件。'),
            data?.transcriptRaw && data?.transcriptReviewed ? h('details', { className: 'dsdash-transcript-reviewed' },
              h('summary', null, `修订稿（${data.transcriptReviewed.length} 字）`),
              h(Markdown, { value: data.transcriptReviewed })) : null,
            checks.length || data?.deepCheck ? h('div', { className: 'dsdash-dive-checks' },
              h('h4', null, `自查：${data?.deepCheck?.passed === true ? '通过' : data?.deepCheck?.passed === false ? '未通过' : '未记录'}`),
              checks.length ? h('ul', null, ...checks.map(([name, value]) => h('li', { key: name }, `${name}: ${value === true ? '通过' : String(value)}`))) : null) : null,
            data?.cardMarkdown ? h(Markdown, { value: data.cardMarkdown }) : notice('该拆解没有 card.md。')))));
    }
    
    function TranscriptLibrary({ report }) {
      const transcripts = array(report.transcripts);
      if (!transcripts.length) return null;
      return h('section', { className: 'dsdash-library' },
        h('div', { className: 'dsdash-library-head' }, h('div', null,
          h('h3', null, `已拆解逐字稿 · ${transcripts.length} 条`),
          h('p', { className: 'dsdash-muted' }, '豆包【新工作任务】→【工作】模式提取；原始输出全文完整展示，修订稿另列，均标“AI辅助，未经真人审核”。'))),
        ...transcripts.map(item => h('details', { className: 'dsdash-transcript', key: item.videoId },
          h('summary', null, `${item.code || item.videoId}｜${item.title || '拆解视频'}${item.revision !== null ? ` · revision-${item.revision}` : ''} · 原始逐字稿 ${(item.raw || '').length} 字`),
          h('div', { className: 'dsdash-transcript-body' },
            item.raw ? h(React.Fragment, null, h('h4', null, '原始逐字稿（豆包输出全文，AI辅助未经真人审核）'), h(Markdown, { value: item.raw })) : notice('该拆解没有 doubao-copy-raw.md，仅存修订稿。'),
            item.reviewed ? h('details', { className: 'dsdash-transcript-reviewed' },
              h('summary', null, `修订稿（${item.reviewed.length} 字，AI辅助整理）`),
              h(Markdown, { value: item.reviewed })) : null))));
    }
    
    function ScriptPromptDialog({ prompt, busy, diveSubmitted, onClose, onChange, onDive, onSubmit }) {
      const video = prompt.video || {};
      const notDived = prompt.kind === 'not-dived';
      const text = prompt.text || '';
      const [hint, setHint] = useState('');
      const submit = () => {
        if (!text.trim()) { setHint('请先填写本次做剧本要求'); return; }
        setHint('');
        onSubmit();
      };
      return h('div', { className: 'dsdash-overlay dsdash-dive-overlay' }, h('section', { className: 'dsdash-dialog dsdash-script-panel', role: 'dialog', 'aria-modal': true, 'aria-label': notDived ? '尚未拆解' : '本次做剧本要求', tabIndex: -1 },
        h('header', { className: 'dsdash-dialog-header' }, h('div', { className: 'dsdash-toolbar' },
          h('h2', null, `${video.code || video.videoId}｜${notDived ? '尚未拆解' : '做原创剧本'}`), button('关闭', onClose))),
        h('div', { className: 'dsdash-dialog-body' },
          notDived ? h(React.Fragment, null,
            notice('该视频还没有拆解，不能直接做原创剧本。'),
            diveSubmitted ? h(React.Fragment, null,
              notice('拆解任务已提交，完成后重新打开报告即可做剧本。', 'info'),
              h('div', { className: 'dsdash-dialog-actions' }, button('关闭', onClose)))
              : h(React.Fragment, null,
                h('p', null, '要生成原创剧本，必须先完成：全片结构观察、评论抽样、豆包完整逐字稿；拆解完成后才能在做剧本时填写本次要求。'),
                h('div', { className: 'dsdash-dialog-actions' },
                  button('先拆解这个视频', onDive, { className: 'dsdash-write-button' }),
                  button('取消', onClose))))
            : h(React.Fragment, null,
              h('label', { className: 'dsdash-script-label' }, '本次做剧本的要求（会随任务交给原会话3；不填则按账号定位与参考机制创作）'),
              h('textarea', { className: 'dsdash-script-input', rows: 7, maxLength: 2000, value: text, placeholder: '例如：面向本地旧房改造业主，30秒口播，突出预算清单与避坑；不要承诺具体价格、工期和效果。', onChange: event => onChange(event.target.value) }),
              h('p', { className: 'dsdash-muted' }, `${text.trim().length}/2000 字`),
              hint ? notice(hint, 'error') : null,
              h('div', { className: 'dsdash-dialog-actions' },
                button('取消', onClose),
                button(busy ? '提交中…' : '提交并做剧本', submit, { className: 'dsdash-write-button', disabled: busy }))))));
    }
    
    function ReportDialog({ moduleKey, initialId, rpc, onClose, onSaved, openSession, tab, setCloseGuard }) {
      const [reports, setReports] = useState([]);
      const [report, setReport] = useState(null);
      const [requestedId, setRequestedId] = useState(initialId);
      const [draft, setDraft] = useState('');
      const [loading, setLoading] = useState(true);
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');
      const [status, setStatus] = useState('');
      const [conflict, setConflict] = useState(false);
      const [view, setView] = useState('deck');
      const [videoStates, setVideoStates] = useState({});
      const [deepStates, setDeepStates] = useState({});
      const [diveDetail, setDiveDetail] = useState(null);
      const [scriptPrompt, setScriptPrompt] = useState(null);
      const [adjustPrompt, setAdjustPrompt] = useState(null);
      const [adjustBusy, setAdjustBusy] = useState(false);
      const dialogRef = useRef(null);
      const readRef = useRef(null);
      const alive = useRef(true);
      const saveBusy = useRef(false);
      const videoActions = useRef(new Map());
      const diveActions = useRef(new Map());
      const reportRef = useRef(null);
      const visibleRef = useRef(tab.visible);
      visibleRef.current = tab.visible;
      const dirty = report !== null && draft !== report.markdown;
      const dirtyRef = useRef(false);
      dirtyRef.current = dirty;
      reportRef.current = report;
      const editable = report?.key === 'session3' && report?.editable === true;
      const confirmLeave = useCallback(() => {
        if (saveBusy.current) { window.alert('正在保存，请等待结果后再离开。'); return false; }
        if ([...videoActions.current.values()].some(action => action.busy)) { window.alert('正在提交选片，请等待结果后再离开报告。'); return false; }
        if ([...diveActions.current.values()].some(action => action.busy)) { window.alert('正在提交拆解，请等待结果后再离开报告。'); return false; }
        return !dirtyRef.current || window.confirm('有未保存的剧本修改。确定放弃这些修改并离开吗？');
      }, []);
      const close = useCallback(() => { if (confirmLeave()) onClose(); }, [confirmLeave, onClose]);
    
      useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; readRef.current?.abort(); };
      }, []);
      useEffect(() => setCloseGuard(() => {
        if (!confirmLeave()) throw new Error('已取消关闭：剧本修改尚未保存');
      }), [setCloseGuard, confirmLeave]);
      useEffect(() => {
        const warn = event => { if (dirtyRef.current || saveBusy.current) { event.preventDefault(); event.returnValue = ''; } };
        window.addEventListener('beforeunload', warn);
        return () => window.removeEventListener('beforeunload', warn);
      }, []);
      useEffect(() => {
        if (!tab.visible) return;
        const previous = document.activeElement;
        dialogRef.current?.focus();
        const keyboard = event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key !== 'Tab') return;
          const focusable = [...(dialogRef.current?.querySelectorAll('button:not([disabled]),a[href],select:not([disabled]),textarea:not([disabled]),[tabindex="0"]') || [])].filter(node => node.getClientRects().length);
          if (!focusable.length) { event.preventDefault(); return; }
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', keyboard, true);
        return () => { document.removeEventListener('keydown', keyboard, true); if (previous?.isConnected) previous.focus(); };
      }, [close, tab.visible]);
    
      const loadReport = useCallback(async id => {
        readRef.current?.abort();
        const controller = new AbortController();
        readRef.current = controller;
        setRequestedId(id); setLoading(true); setError(''); setStatus(''); setConflict(false); setReport(null); setDraft(''); setVideoStates({});
        try {
          const result = await rpc('getReport', { reportId: id }, controller.signal);
          if (controller.signal.aborted || !alive.current) return;
          if (!result || result.id !== id || result.key !== moduleKey || typeof result.markdown !== 'string' || typeof result.revision !== 'string') throw new Error('报告响应不符合接口，未展示');
          setReport(result); setDraft(result.markdown); setView('deck');
          setVideoStates(Object.fromEntries(array(result.videos).map(video => [video.videoId, videoActions.current.get(`${id}\0${video.videoId}`)?.resultState || {}])));
          setDeepStates(Object.fromEntries(array(result.videos).map(video => [video.videoId, diveActions.current.get(`${id}\0${video.videoId}`)?.resultState || {}])));
        } catch (failure) { if (!ABORTED(failure) && !controller.signal.aborted && alive.current) setError(messageOf(failure)); }
        finally { if (!controller.signal.aborted && alive.current) setLoading(false); }
      }, [rpc, moduleKey]);
      useEffect(() => {
        const controller = new AbortController();
        rpc('listReports', { key: moduleKey }, controller.signal).then(result => {
          if (!controller.signal.aborted) setReports(array(result?.reports).filter(item => item?.key === moduleKey && typeof item.id === 'string'));
        }).catch(failure => { if (!ABORTED(failure) && !controller.signal.aborted) setError(messageOf(failure)); });
        loadReport(initialId);
        return () => controller.abort();
      }, [rpc, moduleKey, initialId, loadReport]);
    
      const save = async () => {
        if (!editable || !dirty || saveBusy.current || conflict) return;
        if (!window.confirm('将当前修改保存为新版本，保留原始报告。确定保存吗？')) return;
        saveBusy.current = true; setSaving(true); setError(''); setStatus('');
        const current = report;
        try {
          const result = await rpc('saveScript', { reportId: current.id, baseRevision: current.revision, content: draft }, tab.signal);
          if (!alive.current || tab.signal.aborted) return;
          if (!result || result.id !== current.id || typeof result.markdown !== 'string' || typeof result.revision !== 'string') throw new Error('保存结果无法确认，请重载核实版本后再操作');
          setReport(result); setDraft(result.markdown); setView('deck'); setStatus('已保存新版本；原始报告保留。'); onSaved();
        } catch (failure) {
          if (!ABORTED(failure) && alive.current) {
            setConflict(failure?.code === 'CONFLICT');
            setError(failure?.code === 'CONFLICT' ? '保存冲突：服务器已有新版本。请先复制保留当前修改，再重载最新版本；不会自动覆盖。' : `${messageOf(failure)}；未确认保存成功，可重载核实。`);
          }
        } finally { saveBusy.current = false; if (alive.current) setSaving(false); }
      };
    
      const submitScript = async (video, requirement) => {
        const current = reportRef.current;
        if (!current || current.key !== 'session2' || typeof video.videoId !== 'string') return;
        const actionKey = `${current.id}\0${video.videoId}`;
        const previous = videoActions.current.get(actionKey);
        if (previous?.busy || previous?.done) return;
        if (!confirmLeave()) return;
        const action = previous && previous.requirement === requirement ? previous : { actionId: crypto.randomUUID(), requirement };
        action.busy = true; videoActions.current.set(actionKey, action);
        setVideoStates(old => ({ ...old, [video.videoId]: { busy: true, text: '正在提交选择…' } }));
        try {
          const result = await rpc('createScript', { reportId: current.id, videoId: video.videoId, actionId: action.actionId, requirement: action.requirement }, tab.signal);
          if (!alive.current || tab.signal.aborted) return;
          const needsVerification = result?.needsVerification !== false;
          const rejected = ['failed', 'blocked', 'rejected'].includes(result?.status);
          if (!needsVerification && !rejected && result?.targetSessionId !== SCRIPT_SESSION) throw new Error('返回的写作会话与绑定会话3不符，已停止导航');
          action.done = !rejected;
          onSaved();
          // A mutation may finish after its source report or selected Session changes.
          // Keep the action identity, but never steal navigation from the new selection.
          if (reportRef.current?.id !== current.id) return;
          const canNavigate = !needsVerification && !rejected;
          const text = needsVerification ? '尚需深拆/交接核验，请先补核；没有宣称剧本任务已完成。' : rejected ? `任务${result.status}，未打开写作会话。` : `任务${taskText(result.task || result.status) || '已接收'}；可打开原会话3查看，接收不等于完成。`;
          action.resultState = { done: action.done, text, targetSessionId: canNavigate ? result.targetSessionId : null };
          setVideoStates(old => ({ ...old, [video.videoId]: action.resultState }));
          if (canNavigate && visibleRef.current) openSession(result.targetSessionId);
        } catch (failure) {
          if (!ABORTED(failure) && alive.current) {
            action.resultState = { text: `${messageOf(failure)}；重试将复用本次动作ID。`, error: true };
            setVideoStates(old => ({ ...old, [video.videoId]: action.resultState }));
          }
        } finally { action.busy = false; }
      };
    
      const prepareScript = video => {
        if (!video || typeof video.videoId !== 'string') return;
        setScriptPrompt(video.deepDived ? { video, kind: 'requirement', text: '' } : { video, kind: 'not-dived' });
      };
    
      const submitAdjust = async () => {
        const current = reportRef.current;
        if (!current || current.key !== 'session3' || !adjustPrompt || adjustBusy) return;
        const requirement = (adjustPrompt.text || '').trim();
        if (!requirement) return;
        setAdjustBusy(true);
        try {
          const result = await rpc('adjustScript', { reportId: current.id, actionId: crypto.randomUUID(), requirement }, tab.signal);
          if (!alive.current || tab.signal.aborted) return;
          const rejected = ['failed', 'blocked', 'rejected'].includes(result?.status);
          if (!rejected && result?.targetSessionId !== SCRIPT_SESSION) throw new Error('返回的写作会话与绑定会话3不符，已停止');
          setAdjustPrompt(null);
          setStatus(rejected ? `调整任务${result.status}，未确认受理。` : `已派给原会话3调整剧本（${taskText(result?.task || result?.status) || '已接收'}）；接收不等于完成，新版本完成后重载报告可见。`);
          onSaved();
        } catch (failure) {
          if (!ABORTED(failure) && alive.current) setStatus(`${messageOf(failure)}；未确认提交成功，可重试。`);
        } finally { if (alive.current) setAdjustBusy(false); }
      };
    
      const deepDive = async (video, options = {}) => {
        const current = reportRef.current;
        if (!current || current.key !== 'session2' || typeof video.videoId !== 'string') return;
        const actionKey = `${current.id}\0${video.videoId}`;
        const previous = diveActions.current.get(actionKey);
        if (previous?.busy || previous?.done) return;
        if (!options.skipConfirm && !window.confirm(`确认让参考视频模块拆解「${video.code || video.videoId} ${video.title || ''}」？\n会派给原会话2做全片结构观察与评论抽样，并要求豆包逐字稿；不会启动会话3。`)) return;
        if (!confirmLeave()) return;
        const action = previous || { actionId: crypto.randomUUID() };
        action.busy = true; diveActions.current.set(actionKey, action);
        setDeepStates(old => ({ ...old, [video.videoId]: { busy: true, text: '正在提交拆解…' } }));
        try {
          const result = await rpc('deepDive', { reportId: current.id, videoId: video.videoId, actionId: action.actionId }, tab.signal);
          if (!alive.current || tab.signal.aborted) return;
          const rejected = ['failed', 'blocked', 'rejected'].includes(result?.status);
          action.done = !rejected;
          if (reportRef.current?.id !== current.id) return;
          const text = rejected ? `拆解任务${result.status}，未确认受理。` : `拆解任务${taskText(result?.task || result?.status) || '已接收'}；接收不等于完成，终态后会回传。`;
          action.resultState = { done: action.done, text, error: rejected };
          setDeepStates(old => ({ ...old, [video.videoId]: action.resultState }));
          onSaved();
        } catch (failure) {
          if (!ABORTED(failure) && alive.current) {
            action.resultState = { text: `${messageOf(failure)}；重试将复用本次动作ID。`, error: true };
            setDeepStates(old => ({ ...old, [video.videoId]: action.resultState }));
          }
        } finally { action.busy = false; }
      };
    
      const openDive = async video => {
        const current = reportRef.current;
        if (!current || current.key !== 'session2' || typeof video.videoId !== 'string') return;
        setDiveDetail({ video, loading: true, data: null, error: '' });
        try {
          const data = await rpc('getDeepDive', { reportId: current.id, videoId: video.videoId }, tab.signal);
          if (!alive.current || tab.signal.aborted) return;
          if (!data || data.videoId !== video.videoId || typeof data.cardMarkdown !== 'string') throw new Error('拆解详情响应不符合接口');
          setDiveDetail({ video, loading: false, data, error: '' });
        } catch (failure) {
          if (!ABORTED(failure) && alive.current) setDiveDetail({ video, loading: false, data: null, error: messageOf(failure) });
        }
      };
    
      const picker = h('label', { className: 'dsdash-muted' }, '历史报告 ', h('select', {
        value: requestedId, disabled: loading || saving,
        onChange: event => { if (confirmLeave()) loadReport(event.target.value); }
      }, ...(reports.some(item => item.id === initialId) ? [] : [h('option', { key: initialId, value: initialId }, '当前报告')]), ...reports.map(item => h('option', { key: item.id, value: item.id }, `${dateText(item.updatedAt)} · ${item.title || item.id}`))));
      const tabs = h('div', { className: 'dsdash-viewtabs', role: 'tablist' },
        button('演示', () => setView('deck'), { className: view === 'deck' ? 'active' : '', 'aria-pressed': view === 'deck', role: 'tab' }),
        button('原文', () => setView('raw'), { className: view === 'raw' ? 'active' : '', 'aria-pressed': view === 'raw', role: 'tab' }),
        editable ? button('编辑', () => setView('edit'), { className: view === 'edit' ? 'active' : '', 'aria-pressed': view === 'edit', role: 'tab' }) : null);
      const deckReport = view === 'edit' ? { ...report, markdown: draft } : report;
      const body = report ? h(React.Fragment, null,
        h('p', { className: 'dsdash-muted' }, `${report.relativePath || ''} · ${dateText(report.updatedAt)}（北京时间）`),
        view === 'edit' && editable ? h(React.Fragment, null,
          h('div', { className: 'dsdash-actions' }, button(saving ? '保存中…' : '保存新版本', save, { disabled: !dirty || saving || conflict }), h('span', { className: 'dsdash-muted' }, dirty ? '有未保存修改' : '内容与已加载版本一致')),
          h('div', { className: 'dsdash-editor-grid' },
            h('section', { className: 'dsdash-editor' }, h('h3', null, '编辑 Markdown'), h('textarea', { 'aria-label': '剧本Markdown编辑', value: draft, disabled: saving, onChange: event => setDraft(event.target.value), spellCheck: false })),
            h('section', null, h('h3', null, '演示预览'), h('div', { className: 'dsdash-preview-scroll' }, report.key === 'session3' ? h(ScriptDeck, { report: deckReport, onAdjust: () => setAdjustPrompt({ text: '' }) }) : h(Deck, { report: deckReport }))))) :
          view === 'raw' ? h(Markdown, { value: report.markdown }) :
            h(React.Fragment, null,
              report.key === 'session3' ? h(ScriptDeck, { report: deckReport, onAdjust: () => setAdjustPrompt({ text: '' }) }) : h(Deck, { report: deckReport,
                filterHeading: report.key === 'session1' ? /^3(?:\.\s|\.\d|\s|$)/ : undefined,
                afterHeading: report.key === 'session1' ? /^2\./ : undefined,
                afterSlide: report.key === 'session1' ? h(AccountLibrary, { report }) : null }),
              report.key === 'session2' ? h(VideoLibrary, { report, videoStates, deepStates, onCreate: prepareScript, onDive: deepDive, onViewDive: openDive, disabled: saving, openSession, confirmLeave }) : null,
              report.key === 'session2' ? h(TranscriptLibrary, { report }) : null),
        array(report.history).length ? h('details', { className: 'dsdash-history' }, h('summary', null, `保存版本记录（${report.history.length}）`), h('ul', null, ...report.history.map((item, index) => h('li', { key: item.versionId || index }, `${dateText(item.createdAt)} · ${item.versionId || '版本'} · ${String(item.revision || '').slice(0, 12)}`)))) : null
      ) : null;
      return !tab.visible ? null : h(React.Fragment, null,
        h('div', { className: 'dsdash-overlay' }, h('section', { ref: dialogRef, className: 'dsdash-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': report?.title || '报告阅读与编辑', tabIndex: -1 },
          h('header', { className: 'dsdash-dialog-header' }, h('div', { className: 'dsdash-toolbar' }, h('h2', null, report?.title || '报告'), button('关闭', close, { 'aria-label': '关闭报告', disabled: saving })), h('div', { className: 'dsdash-actions' }, tabs, picker, button('重载报告', () => { if (confirmLeave()) loadReport(requestedId); }, { disabled: loading || saving }))),
          h('div', { className: 'dsdash-dialog-body' }, notice(error, 'error'), notice(status, 'success'), loading ? notice('正在加载报告…') : body)
        )),
        diveDetail ? h(DeepDivePanel, { detail: diveDetail, onClose: () => setDiveDetail(null) }) : null,
        scriptPrompt ? h(ScriptPromptDialog, {
          prompt: scriptPrompt,
          busy: false,
          diveSubmitted: Boolean(deepStates[scriptPrompt.video.videoId]?.done),
          onClose: () => setScriptPrompt(null),
          onChange: text => setScriptPrompt(old => old ? { ...old, text } : old),
          onDive: video => { setScriptPrompt(null); deepDive(video, { skipConfirm: true }); },
          onSubmit: () => { const pending = scriptPrompt; setScriptPrompt(null); submitScript(pending.video, (pending.text || '').trim()); }
        }) : null,
        adjustPrompt ? h(AdjustScriptDialog, {
          text: adjustPrompt.text || '',
          busy: adjustBusy,
          onClose: () => { if (!adjustBusy) setAdjustPrompt(null); },
          onChange: text => setAdjustPrompt(old => old ? { ...old, text } : old),
          onSubmit: submitAdjust
        }) : null);
    }
    
    function Dashboard({ rpc, openSession, tab, setCloseGuard }) {
      const [cards, setCards] = useState([]), [loading, setLoading] = useState(true), [error, setError] = useState('');
      const [updated, setUpdated] = useState(null), [operations, setOperations] = useState({}), [selected, setSelected] = useState(null);
      const request = useRef(null), active = useRef(true), actions = useRef(new Map());
      const refresh = useCallback(async () => {
        request.current?.abort(); const controller = new AbortController(); request.current = controller;
        setLoading(true); setError('');
        try {
          const result = await rpc('listCards', {}, controller.signal);
          if (!active.current || controller.signal.aborted) return;
          if (!Array.isArray(result?.cards)) throw new Error('卡片响应无效');
          setCards(result.cards); setUpdated(new Date().toISOString());
        } catch (failure) { if (!ABORTED(failure) && active.current && !controller.signal.aborted) setError(messageOf(failure)); }
        finally { if (active.current && !controller.signal.aborted) setLoading(false); }
      }, [rpc]);
      useEffect(() => { active.current = true; refresh(); return () => { active.current = false; request.current?.abort(); }; }, [refresh]);
      const update = async card => {
        if (card.key === 'session3') return;
        const previous = actions.current.get(card.key);
        if (previous?.busy) return;
        if (!window.confirm(`确认向「${card.title}」原模块发起更新任务？\n这会唤醒对应模块，状态刷新本身不会唤醒模型。`)) return;
        const action = previous || { actionId: crypto.randomUUID() };
        action.busy = true; actions.current.set(card.key, action);
        setOperations(old => ({ ...old, [card.key]: { busy: true, text: '提交中…' } }));
        try {
          const result = await rpc('updateModule', { key: card.key, actionId: action.actionId }, tab.signal);
          if (!active.current || tab.signal.aborted) return;
          setOperations(old => ({ ...old, [card.key]: { text: `${taskText(result?.task || result?.status) || '请求已返回'}；业务结果以真实终态为准。` } }));
          actions.current.delete(card.key); refresh();
        } catch (failure) {
          if (!ABORTED(failure) && active.current) setOperations(old => ({ ...old, [card.key]: { text: `${messageOf(failure)}；重试复用原动作ID。`, error: true } }));
        } finally { action.busy = false; }
      };
      const closeReport = useCallback(() => setSelected(null), []);
      return h('div', { className: 'dsdash' },
        h('div', { className: 'dsdash-toolbar' }, h('h2', null, '五模块工作台'), button(loading ? '读取中…' : '刷新状态', refresh, { disabled: loading })),
        h('p', { className: 'dsdash-muted' }, '只在总管会话显示 · 刷新只读取状态，不唤醒模型'),
        updated ? h('p', { className: 'dsdash-muted' }, `状态读取：${dateText(updated)}（北京时间）`) : null,
        notice(error, 'error'),
        h('div', { className: 'dsdash-cards' }, ...MODULES.map(([key, title]) => {
          const card = cards.find(item => item?.key === key) || { key, title, empty: true };
          const meta = MODULE_META[key];
          const operation = operations[key] || {};
          const running = ['accepted', 'queued', 'started', 'running'].includes(card.task?.status || card.task?.state);
          const taskState = running ? 'busy' : ['failed', 'blocked'].includes(card.task?.status) ? 'fail' : card.task?.status === 'completed' ? 'done' : '';
          return h('section', { className: 'dsdash-card', key, style: { '--accent': meta.accent } },
            h('h3', null, title, card.task ? h('span', { className: `dsdash-pill ${taskState}` }, taskText(card.task)) : null),
            h('p', null, clamp(card.reportTitle || (loading ? '正在读取…' : '暂无报告'), 86)),
            h('p', { className: 'dsdash-muted' }, `${dateText(card.updatedAt)}${card.updatedAtSource ? ` · 来源：${card.updatedAtSource}` : ''}`),
            h('div', { className: 'dsdash-actions' },
              button(key === 'session3' ? '查看 / 编辑' : '查看报告', () => setSelected({ key, id: card.reportId }), { disabled: !card.reportId }),
              key === 'session3' ? h('span', { className: 'dsdash-muted' }, '从参考视频确认选片后创作') : button(operation.busy ? '提交中…' : operation.error ? '重试更新' : '更新模块', () => update({ ...card, title }), { disabled: loading || !!error || operation.busy || running })),
            notice(operation.text, operation.error ? 'error' : 'info'));
        })),
        selected ? h(ReportDialog, { key: `${selected.key}:${selected.id}`, moduleKey: selected.key, initialId: selected.id, rpc, onClose: closeReport, onSaved: refresh, openSession, tab, setCloseGuard }) : null
      );
    }
    
    const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection', 'uiWorkspace'];
    function apply(ctx) {
      const guards = new Map();
      ctx.effect(() => {
        const controller = new AbortController();
        void ctx.connection.rpc.call(CHANNEL, 'clientReady', { controllerSessionId: CONTROLLER }, controller.signal).catch(() => {});
        return () => controller.abort();
      }, 'sidebar-dashboard: client readiness');
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'workspace-sidebar-dashboard';
        tag.dataset.pluginCss = 'workspace-sidebar-dashboard/styles';
        tag.textContent = CSS; document.head.appendChild(tag);
        return () => tag.remove();
      }, 'sidebar-dashboard: styles');
      ctx.effect(() => ctx.sidebarRightTabs.register({ id: TYPE_ID, kind: KIND, title: () => '五模块工作台', keepMounted: true }), 'sidebar-dashboard: tab type');
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(KIND, (_sessionId, tab) => guards.get(tab.id)?.()), 'sidebar-dashboard: unsaved close guard');
      const rpcFor = sessionId => async (method, payload, signal) => {
        if (sessionId !== CONTROLLER) throw new Error('此面板仅限总管会话');
        const result = await ctx.connection.rpc.call(CHANNEL, method, { ...payload, controllerSessionId: CONTROLLER }, signal);
        if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message || '请求失败'), { code: result?.error?.code || 'RPC_ERROR', details: result?.error?.details });
        return result.value;
      };
      function Panel(props) {
        const { tab } = props.useTabInfo();
        const setCloseGuard = useCallback(guard => {
          guards.set(tab.id, guard);
          return () => { if (guards.get(tab.id) === guard) guards.delete(tab.id); };
        }, [tab.id]);
        if (props.sessionId !== CONTROLLER) return null;
        return h(Dashboard, { rpc: props.rpc, openSession: props.openSession, tab, setCloseGuard });
      }
      function Entry({ sessionId, open }) {
        return sessionId === CONTROLLER ? h('button', { type: 'button', className: 'dsdash-title-button', title: '打开五模块工作台', onClick: open }, '五模块工作台') : null;
      }
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: TYPE_ID,
        inject: sessionId => ({ rpc: rpcFor(sessionId), openSession: id => ctx.uiWorkspace.openSession(id) })
      }, Panel));
      ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TYPE_ID }, ({ sessionId }) => sessionId === CONTROLLER ? h('span', null, '五模块工作台') : null));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'workspace-sidebar-dashboard/entry', order: -8,
        inject: sessionId => ({ open: () => { if (sessionId === CONTROLLER) ctx.sidebarRight.openTab(KIND); } })
      }, Entry));
      ctx.effect(() => () => guards.clear(), 'sidebar-dashboard: guard cleanup');
    }
    
    return { inject, apply };
  }
});
