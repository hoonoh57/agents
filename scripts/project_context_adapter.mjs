import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PROJECT_CONTEXT_INPUT_SCHEMA = 'ProjectContextInput@1.0.0';
const ALLOWED_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.txt', '.csv']);
const MAX_SOURCE = 1024 * 1024;
const MAX_EXCERPT = 16 * 1024;
const DEFAULT_TOTAL = 18 * 1024;
const AGENT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(code, detail) { throw new Error(`CONTEXT_${code}:${detail}`); }
function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function bytes(text) { return Buffer.byteLength(String(text), 'utf8'); }

function relativePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || path.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) fail('PATH_INVALID', raw || 'missing');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length || parts.some(x => x === '.' || x === '..' || x.startsWith('.'))) fail('PATH_FORBIDDEN', raw);
  return parts.join('/');
}

function repositoryHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || null;
  } catch { return null; }
}

function excerpt(text, input) {
  const mode = String(input.mode || 'FULL').toUpperCase();
  const limit = Math.max(256, Math.min(MAX_EXCERPT, Number(input.maxBytes || 8192)));
  if (mode === 'FULL') {
    if (bytes(text) > limit) fail('FULL_TOO_LARGE', `${input.inputId}:${bytes(text)}>${limit}`);
    return { mode, anchor: null, text };
  }
  if (mode !== 'AROUND') fail('MODE_INVALID', `${input.inputId}:${mode}`);
  const anchor = String(input.anchor || '');
  const index = anchor ? text.indexOf(anchor) : -1;
  if (index < 0) fail('ANCHOR_NOT_FOUND', `${input.inputId}:${anchor || 'missing'}`);
  const before = Math.max(0, Math.min(6000, Number(input.beforeChars || 600)));
  const after = Math.max(0, Math.min(10000, Number(input.afterChars || 2600)));
  let out = text.slice(Math.max(0, index - before), Math.min(text.length, index + anchor.length + after));
  if (bytes(out) > limit) out = Buffer.from(out, 'utf8').subarray(0, limit).toString('utf8').replace(/\uFFFD+$/g, '');
  return { mode, anchor, text: out };
}

function configuredRoot(inputRoot, env) {
  if (inputRoot === 'RESEARCH_LOCAL_ROOT') {
    const configured = String(env.RESEARCH_LOCAL_ROOT || '').trim();
    if (!configured) fail('ROOT_NOT_CONFIGURED', 'RESEARCH_LOCAL_ROOT');
    return { rootName: 'RESEARCH_LOCAL_ROOT', root: fs.realpathSync.native(path.resolve(configured)) };
  }
  if (inputRoot === 'AGENT_REPO_ROOT') {
    return { rootName: 'AGENT_REPO_ROOT', root: fs.realpathSync.native(AGENT_REPO_ROOT) };
  }
  fail('ROOT_INVALID', String(inputRoot || 'missing'));
}

function resolveOne(input, env) {
  if (!input || input.schema !== PROJECT_CONTEXT_INPUT_SCHEMA) fail('SCHEMA_INVALID', String(input?.schema || 'missing'));
  const inputId = String(input.inputId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(inputId)) fail('INPUT_ID_INVALID', inputId || 'missing');
  const resolvedRoot = configuredRoot(input.root, env);
  const root = resolvedRoot.root;
  const rel = relativePath(input.path);
  if (!ALLOWED_EXT.has(path.extname(rel).toLowerCase())) fail('EXTENSION_INVALID', rel);
  const candidate = path.resolve(root, ...rel.split('/'));
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) fail('FILE_MISSING', rel);
  const file = fs.realpathSync.native(candidate);
  const back = path.relative(root, file);
  if (back.startsWith('..') || path.isAbsolute(back)) fail('ROOT_ESCAPE', rel);
  const raw = fs.readFileSync(file);
  if (raw.length > MAX_SOURCE) fail('SOURCE_TOO_LARGE', `${rel}:${raw.length}`);
  const picked = excerpt(raw.toString('utf8'), input);
  return {
    inputId, root: resolvedRoot.rootName, relativePath: rel,
    repositoryHead: repositoryHead(root), fileSha256: hash(raw), excerptSha256: hash(Buffer.from(picked.text, 'utf8')),
    sourceBytes: raw.length, excerptBytes: bytes(picked.text), mode: picked.mode, anchor: picked.anchor, text: picked.text,
  };
}

export function resolveTaskInputs(task, env = process.env) {
  const maxTotal = Math.max(1024, Math.min(48 * 1024, Number(env.AGENT_CONTEXT_MAX_BYTES || DEFAULT_TOTAL)));
  const sources = [];
  const ids = new Set();
  let totalBytes = 0;
  for (const input of Array.isArray(task?.inputs) ? task.inputs : []) {
    const source = resolveOne(input, env);
    if (ids.has(source.inputId)) fail('DUPLICATE_INPUT_ID', source.inputId);
    ids.add(source.inputId);
    totalBytes += source.excerptBytes;
    if (totalBytes > maxTotal) fail('TOTAL_TOO_LARGE', `${totalBytes}>${maxTotal}`);
    sources.push(source);
  }
  const sourceRefs = sources.map(({ text, ...ref }) => ref);
  const promptSection = sources.length ? sources.map(s => [
    `## SOURCE ${s.inputId}`,
    JSON.stringify(sourceRefs.find(ref => ref.inputId === s.inputId)),
    '--- BEGIN SOURCE DATA ---', s.text, '--- END SOURCE DATA ---',
  ].join('\n')).join('\n\n') : '(none)';
  return { sourceRefs, promptSection, totalBytes };
}
