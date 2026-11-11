import { readFile, mkdir, open, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const render = await readFile(path.join(root, 'render.mjs'), 'utf8');
const deck = await readFile(path.join(root, 'deck.mjs'), 'utf8');
const client = await readFile(path.join(root, 'client.mjs'), 'utf8');
const HEADER = [
  "import React from 'react';",
  "import { renderMarkdown, safeHttpsUrl } from './render.mjs';",
  "import { buildDeck, condense, formatNumber } from './deck.mjs';",
  '',
].join('\n');
if (!client.startsWith(HEADER)) throw new Error('Unexpected client imports; update the audited builder explicitly');
for (const source of [render, deck]) if (/^\s*import\s/m.test(source)) throw new Error('Bundled helper modules must not import anything');
const stripExports = source => source
  .replaceAll('export function ', 'function ')
  .replaceAll('export const ', 'const ')
  .replaceAll('export class ', 'class ');
const body = [
  stripExports(render),
  stripExports(deck),
  stripExports(client.slice(HEADER.length).replace(/^/, "const React = require('react');\n")),
].join('\n');
if (/^\s*export\s/m.test(body) || /^\s*import\s/m.test(body)) throw new Error('Unbundled ESM syntax remains');
const bundle = `window.__ModuleLoader__.load({\n  id: 'workspace-sidebar-dashboard',\n  factory: (require) => {\n    'use strict';\n${body.split('\n').map(line => '    ' + line).join('\n')}\n    return { inject, apply };\n  }\n});\n`;
const dir = path.join(root, 'lib');
await mkdir(dir, { recursive: true });
const target = path.join(dir, 'client.js');
const temporary = path.join(dir, `client-${randomUUID()}.tmp`);
const handle = await open(temporary, 'wx');
try { await handle.writeFile(bundle, 'utf8'); await handle.sync(); } finally { await handle.close(); }
await rename(temporary, target);
const info = await stat(target);
console.log(JSON.stringify({ output: target, bytes: info.size }, null, 2));
