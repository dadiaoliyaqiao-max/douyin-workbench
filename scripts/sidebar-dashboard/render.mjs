/** Deliberately small Markdown renderer. Raw HTML and embedded media are never interpreted. */
const MAX_RENDER_CHARS = 300_000;
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

/** Only explicit HTTPS destinations, without credentials or control characters. */
export function safeHttpsUrl(value) {
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
export function renderMarkdown(markdown) {
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
