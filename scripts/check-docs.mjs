import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BANNED_TERMS = ['原著', '完整检查', '孤立事件'];
const PRIVACY_CHECKS = [
  {label: '/home/', test: line => line.includes('/home/')},
  {label: '/Users/', test: line => line.includes('/Users/')},
  {label: 'C:\\Users', test: line => /[A-Za-z]:\\Users/i.test(line)},
  {label: 'syncL', test: line => line.includes('syncL')},
  {label: 'reports/YG-VIEW-', test: line => /reports\/YG-(?:VIEW-|[A-Z0-9]+-)/i.test(line)},
];

const compareCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const toPosix = p => p.split(path.sep).join('/');
const safeDecode = value => {
  try { return decodeURIComponent(value); } catch { return value; }
};

export function slugifyHeading(raw) {
  const plain = raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '');
  return plain
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function updateFence(line, currentFence) {
  if (!currentFence) {
    const open = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!open) return {inFence: false, nextFence: null, toggled: false};
    const mark = open[1];
    if (mark[0] === '`' && open[2].includes('`')) return {inFence: false, nextFence: null, toggled: false};
    return {inFence: true, nextFence: {char: mark[0], len: mark.length}, toggled: true};
  }
  const close = line.match(/^\s*([`~]{3,})\s*$/);
  if (close && close[1][0] === currentFence.char && close[1].length >= currentFence.len) {
    return {inFence: true, nextFence: null, toggled: true};
  }
  return {inFence: true, nextFence: currentFence, toggled: false};
}

function collectAnchors(text) {
  const anchors = new Set();
  const seen = new Map();
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const state = updateFence(line, fence);
    fence = state.nextFence;
    if (state.inFence || state.toggled) continue;
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (!match) continue;
    const heading = match[1].replace(/\s+#+\s*$/, '');
    const base = slugifyHeading(heading);
    let count = seen.get(base) ?? 0;
    let slug = count === 0 ? base : `${base}-${count}`;
    while (anchors.has(slug)) {
      count += 1;
      slug = `${base}-${count}`;
    }
    seen.set(base, count + 1);
    anchors.add(slug);
  }
  return anchors;
}

async function isRegularFile(filePath) {
  try { return (await fs.stat(filePath)).isFile(); } catch { return false; }
}

async function walkMarkdown(absRoot, relDir) {
  const start = path.join(absRoot, relDir);
  try {
    if (!(await fs.stat(start)).isDirectory()) return [];
  } catch { return []; }
  const out = [];
  async function visit(currentAbs, currentRel) {
    const entries = await fs.readdir(currentAbs, {withFileTypes: true});
    entries.sort((a, b) => compareCodePoint(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const nextRel = toPosix(path.join(currentRel, entry.name));
      const nextAbs = path.join(currentAbs, entry.name);
      if (entry.isDirectory()) {
        if (nextRel === 'docs/归档') continue;
        await visit(nextAbs, nextRel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(nextRel);
      }
    }
  }
  await visit(start, toPosix(relDir));
  return out;
}

function stripGlossaryUnusedColumn(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || /^\|[\s|:-]+\|$/.test(trimmed)) return line;
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.length >= 2 ? cells.slice(1).join('|') : line;
}

export async function checkDocs(root = DEFAULT_ROOT) {
  const absRoot = path.resolve(root);
  const candidates = [];
  for (const single of ['README.md', 'view/README.md']) {
    if (await isRegularFile(path.join(absRoot, single))) candidates.push(single);
  }
  candidates.push(...await walkMarkdown(absRoot, 'docs'));
  candidates.push(...await walkMarkdown(absRoot, 'skills'));
  const files = [...new Set(candidates)].sort(compareCodePoint);

  const fileTexts = new Map();
  const anchorCache = new Map();
  await Promise.all(files.map(async rel => {
    const abs = path.join(absRoot, rel);
    const text = await fs.readFile(abs, 'utf8');
    fileTexts.set(rel, text);
    anchorCache.set(abs, collectAnchors(text));
  }));

  async function getAnchorsForFile(absFile) {
    if (anchorCache.has(absFile)) return anchorCache.get(absFile);
    const text = await fs.readFile(absFile, 'utf8');
    const anchors = collectAnchors(text);
    anchorCache.set(absFile, anchors);
    return anchors;
  }

  let linkCount = 0;
  let anchorCount = 0;
  const errors = [];

  for (const relFile of files) {
    const absFile = path.join(absRoot, relFile);
    const lines = fileTexts.get(relFile).split(/\r?\n/);
    const isGlossary = relFile === 'docs/术语.md';
    let inGlossaryTable = false;
    let fence = null;

    for (let index = 0; index < lines.length; index++) {
      const lineNo = index + 1;
      const line = lines[index];
      const state = updateFence(line, fence);
      fence = state.nextFence;
      if (state.inFence || state.toggled) continue;

      if (isGlossary) {
        const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
        if (headingMatch) {
          const title = headingMatch[2].replace(/\s+#+\s*$/, '').trim();
          if (headingMatch[1].length <= 2) inGlossaryTable = title === '统一用语';
        }
      }

      const termScanLine = (isGlossary && inGlossaryTable) ? stripGlossaryUnusedColumn(line) : line;
      for (const term of BANNED_TERMS) {
        if (termScanLine.includes(term)) {
          errors.push({rule: 'banned-term', file: relFile, line: lineNo, detail: `禁用术语“${term}”`});
        }
      }
      for (const check of PRIVACY_CHECKS) {
        if (check.test(line)) {
          errors.push({rule: 'privacy-path', file: relFile, line: lineNo, detail: `疑似本机或私有路径（${check.label}）`});
        }
      }
      if (line.includes('examples/雾港')) {
        errors.push({rule: 'legacy-path', file: relFile, line: lineNo, detail: '含旧示例路径“examples/雾港”'});
      }

      const linkLine = line.replace(/`[^`]*`/g, '');
      for (const match of linkLine.matchAll(/!?\[[^\]]*\]\(([^)\r\n]+)\)/g)) {
        const cleaned = match[1].trim()
          .replace(/^<(.+)>$/, '$1')
          .replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '')
          .trim();
        if (!cleaned || /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(cleaned)) continue;

        linkCount += 1;
        const hashIdx = cleaned.indexOf('#');
        const rawFile = hashIdx === -1 ? cleaned : cleaned.slice(0, hashIdx);
        const rawAnchor = hashIdx === -1 ? '' : cleaned.slice(hashIdx + 1);
        if (hashIdx !== -1) anchorCount += 1;

        const decodedFile = safeDecode(rawFile);
        const targetAbs = decodedFile ? path.resolve(path.dirname(absFile), decodedFile) : absFile;

        let stat = null;
        if (decodedFile) {
          try { stat = await fs.stat(targetAbs); } catch { stat = null; }
          if (!stat) {
            errors.push({rule: 'broken-link', file: relFile, line: lineNo, detail: `失效相对链接：${cleaned}`});
            continue;
          }
        }
        if (hashIdx !== -1 && (!stat || stat.isFile()) && targetAbs.toLowerCase().endsWith('.md')) {
          const decodedAnchor = safeDecode(rawAnchor);
          const anchors = await getAnchorsForFile(targetAbs);
          if (!decodedAnchor || !anchors.has(decodedAnchor)) {
            errors.push({rule: 'broken-anchor', file: relFile, line: lineNo, detail: `失效锚点：${cleaned}`});
          }
        }
      }
    }
  }
  return {files, linkCount, anchorCount, errors};
}

async function main(argv) {
  let json = false;
  let root = DEFAULT_ROOT;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    else root = path.resolve(arg);
  }
  const result = await checkDocs(root);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.errors.length === 0) {
    process.stdout.write(
      `check-docs: ${result.files.length} 个文件，${result.linkCount} 个相对链接，${result.anchorCount} 个锚点，0 错误\n`,
    );
  } else {
    for (const err of result.errors) {
      process.stderr.write(`${err.rule} ${err.file}:${err.line} ${err.detail}\n`);
    }
    process.stderr.write(
      `check-docs: ${result.files.length} 个文件，${result.linkCount} 个相对链接，${result.anchorCount} 个锚点，共 ${result.errors.length} 个错误\n`,
    );
  }
  return result.errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
