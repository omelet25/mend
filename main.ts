// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// A file is held as an array of its lines, plus its line break and whether it
// ends with one. The matching searches are built so a patch's cost stays
// proportional to the files' lines plus the patch's own lines:
//
// - tier 1/2 comparisons normalise the single line being compared, never a
//   whole-file copy;
// - a unified hunk searches outward from the position it names, so a section
//   of many hunks over one large file does not rescan the file per hunk;
// - SEARCH/REPLACE counts occurrences through the first line of its block,
//   which almost every position fails at once;
// - V4A chunks only ever scan forward from their cursor.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeSync } from 'node:fs';

// ---------------------------------------------------------------- text model

interface FileState {
  lines: string[];
  eol: string; // '\n' or '\r\n'
  tail: boolean; // the text ends with a line break
}

function parseText(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', tail: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text.charCodeAt(nl - 1) === 13 ? '\r\n' : '\n';
  const parts = text.split(eol);
  let tail = false;
  if (parts[parts.length - 1] === '') {
    parts.pop();
    tail = true;
  }
  return { lines: parts, eol, tail };
}

function printText(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.eol) + (st.tail ? st.eol : '');
}

/** A patch's lines: split at \n, one trailing \r removed, no final empty piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ------------------------------------------------------------- small helpers

const isBlank = (s: string): boolean => s.trim() === '';

function rtrim(s: string): string {
  let e = s.length;
  while (e > 0 && (s.charCodeAt(e - 1) === 32 || s.charCodeAt(e - 1) === 9)) e -= 1;
  return s.slice(0, e);
}

function trimWs(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a += 1;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b -= 1;
  return s.slice(a, b);
}

function leadWs(s: string): string {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i += 1;
  return s.slice(0, i);
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

class ParseError {
  line: number;
  constructor(line: number) {
    this.line = line;
  }
}

// ------------------------------------------------------------------- the tree

interface DiskInfo {
  exists: boolean;
  text: string | null; // null when there is no readable file (absent, or a directory)
}

class Tree {
  private disk = new Map<string, DiskInfo>();
  private virt = new Map<string, FileState | null>();

  info(path: string): DiskInfo {
    let d = this.disk.get(path);
    if (d === undefined) {
      let exists = false;
      let text: string | null = null;
      try {
        const st = statSync(path);
        exists = true;
        if (st.isFile()) text = readFileSync(path, 'utf8');
      } catch {
        exists = false;
      }
      d = { exists, text };
      this.disk.set(path, d);
    }
    return d;
  }

  existsNow(path: string): boolean {
    if (this.virt.has(path)) return this.virt.get(path) !== null;
    return this.info(path).exists;
  }

  stateNow(path: string): FileState | null {
    if (this.virt.has(path)) return this.virt.get(path) ?? null;
    const d = this.info(path);
    return d.text !== null ? parseText(d.text) : null;
  }

  set(path: string, state: FileState | null): void {
    this.virt.set(path, state);
  }

  beforeText(path: string): string | null {
    return this.info(path).text;
  }

  finalText(path: string): string | null {
    if (this.virt.has(path)) {
      const s = this.virt.get(path);
      return s ? printText(s) : null;
    }
    return this.info(path).text;
  }

  touched(): string[] {
    return [...this.virt.keys()];
  }
}

// -------------------------------------------------------------- line matching

type Tier = 0 | 1 | 2;

function prepTier(lines: string[], tier: Tier): string[] {
  if (tier === 0) return lines;
  if (tier === 1) return lines.map(rtrim);
  return lines.map(trimWs);
}

function lineIs(line: string, want: string, tier: Tier): boolean {
  if (tier === 0) return line === want;
  if (tier === 1) return rtrim(line) === want;
  return trimWs(line) === want;
}

function matchAt(lines: string[], pos: number, po: string[], tier: Tier): boolean {
  for (let j = 0; j < po.length; j += 1) {
    if (!lineIs(lines[pos + j], po[j], tier)) return false;
  }
  return true;
}

interface Found {
  pos: number;
  tier: Tier;
}

/** The occurrence nearest to `target` at the first tier that has one (ties: the earlier). */
function findNearest(lines: string[], o: string[], tiers: Tier[], target: number): Found | null {
  const maxPos = lines.length - o.length;
  if (maxPos < 0) return null;
  for (const tier of tiers) {
    const po = prepTier(o, tier);
    let d = 0;
    if (target < 0) d = -target;
    else if (target > maxPos) d = target - maxPos;
    for (;;) {
      const a = target - d;
      const b = target + d;
      const aIn = a >= 0 && a <= maxPos;
      const bIn = b >= 0 && b <= maxPos;
      if (!aIn && !bIn && a < 0 && b > maxPos) break;
      if (aIn && matchAt(lines, a, po, tier)) return { pos: a, tier };
      if (d > 0 && bIn && matchAt(lines, b, po, tier)) return { pos: b, tier };
      d += 1;
    }
  }
  return null;
}

/** The first occurrence at or after `from`, at the first tier that has one. */
function findForward(lines: string[], o: string[], tiers: Tier[], from: number): Found | null {
  const maxPos = lines.length - o.length;
  for (const tier of tiers) {
    const po = prepTier(o, tier);
    for (let i = Math.max(from, 0); i <= maxPos; i += 1) {
      if (matchAt(lines, i, po, tier)) return { pos: i, tier };
    }
  }
  return null;
}

/** Occurrences of `o` (counted up to `cap`) at the first tier that has one. */
function countOccurrences(
  lines: string[],
  o: string[],
  tiers: Tier[],
  cap: number,
): { count: number; pos: number; tier: Tier } {
  const maxPos = lines.length - o.length;
  if (maxPos < 0) return { count: 0, pos: -1, tier: tiers[0] };
  for (const tier of tiers) {
    const po = prepTier(o, tier);
    const keyOf = tier === 0 ? (s: string) => s : tier === 1 ? rtrim : trimWs;
    const want = po[0];
    let count = 0;
    let pos = -1;
    for (let i = 0; i <= maxPos; i += 1) {
      if (keyOf(lines[i]) !== want) continue;
      if (matchAt(lines, i, po, tier)) {
        count += 1;
        if (pos < 0) pos = i;
        if (count >= cap) break;
      }
    }
    if (count > 0) return { count, pos, tier };
  }
  return { count: 0, pos: -1, tier: tiers[0] };
}

// ------------------------------------------------------------- building lines

type BodyKind = 'ctx' | 'old' | 'new' | 'bsl';

interface BodyLine {
  kind: BodyKind;
  text: string;
}

/**
 * The lines a matched block is replaced by: context lines are the file's own
 * matched lines; at tier 2 the other lines are re-indented (SPEC section 5).
 */
function buildNew(lines: string[], pos: number, items: BodyLine[], tier: Tier): string[] {
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWs(lines[pos]);
    for (const b of items) {
      if (b.kind === 'ctx' || b.kind === 'old') {
        p = leadWs(b.text);
        break;
      }
    }
  }
  const out: string[] = [];
  let oi = 0;
  for (const b of items) {
    if (b.kind === 'ctx') {
      out.push(lines[pos + oi]);
      oi += 1;
    } else if (b.kind === 'old') {
      oi += 1;
    } else if (b.kind === 'new') {
      let t = b.text;
      if (tier === 2 && t !== '' && !isBlank(t) && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

function spliceIn(lines: string[], pos: number, del: number, ins: string[]): void {
  if (ins.length <= 4096) {
    lines.splice(pos, del, ...ins);
    return;
  }
  const rest = lines.slice(pos + del);
  lines.length = pos;
  for (const l of ins) lines.push(l);
  for (const l of rest) lines.push(l);
}

/** Whether a `\` line follows the body's last context or new line. */
function backslashAfter(items: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].kind === 'ctx' || items[i].kind === 'new') last = i;
  }
  return last >= 0 && last + 1 < items.length && items[last + 1].kind === 'bsl';
}

// --------------------------------------------------------------------- edits

interface Fail {
  code: string;
  path: string;
}

interface MoveRec {
  from: string;
  to: string;
}

interface Hunk {
  a: number;
  items: BodyLine[];
  bslAfter: boolean;
}

type Edit =
  | { type: 'u-create'; paths: string[]; path: string; hunks: Hunk[] }
  | { type: 'u-delete'; paths: string[]; path: string }
  | { type: 'u-change'; paths: string[]; path: string; hunks: Hunk[] }
  | { type: 'u-move'; paths: string[]; from: string; to: string; hunks: Hunk[] }
  | { type: 'sr-create'; paths: string[]; path: string; newLines: string[] }
  | { type: 'sr-change'; paths: string[]; path: string; oldLines: string[]; newLines: string[] }
  | { type: 'v-add'; paths: string[]; path: string; fileLines: string[] }
  | { type: 'v-delete'; paths: string[]; path: string }
  | { type: 'v-update'; paths: string[]; path: string; moveTo: string | null; chunks: Chunk[] }
  | { type: 'j-create'; paths: string[]; path: string; text: string }
  | { type: 'j-str'; paths: string[]; path: string; oldStr: string; newStr: string }
  | { type: 'j-insert'; paths: string[]; path: string; line: number; newLines: string[] };

interface Chunk {
  anchor: string | null;
  eof: boolean;
  items: BodyLine[];
}

// ------------------------------------------------------------------- unified

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  hasPair: boolean;
  pairOld: string | null; // null with hasPair: /dev/null
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function newSection(): UniSection {
  return {
    gitOld: null,
    gitNew: null,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    delFile: false,
    hunks: [],
  };
}

/** The path a --- or +++ line names: after the four characters, up to a tab, spaces removed. */
function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimWs(t);
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function renamePath(line: string, prefix: string): string {
  let t = line.slice(prefix.length);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return trimWs(t);
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/;
const GIT_RE = /^a\/(.+?) b\/(.+)$/;

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let body: BodyLine[] | null = null;
  let bodyRaw: string[] = [];

  const endBody = (): void => {
    if (body === null || sec === null) return;
    // Empty lines at the end of a body are not part of it.
    while (body.length > 0 && bodyRaw[bodyRaw.length - 1] === '') {
      body.pop();
      bodyRaw.pop();
    }
    sec.hunks[sec.hunks.length - 1].items = body;
    sec.hunks[sec.hunks.length - 1].bslAfter = backslashAfter(body);
    body = null;
    bodyRaw = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (body !== null) {
      const c = line.charAt(0);
      const startsSection =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ '));
      if (!startsSection && (c === ' ' || c === '-' || c === '+' || c === '\\' || line === '')) {
        const kind: BodyKind = c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : c === '\\' ? 'bsl' : 'ctx';
        body.push({ kind, text: kind === 'bsl' ? '' : line.slice(1) });
        bodyRaw.push(line);
        continue;
      }
      endBody();
    }

    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line.slice(11));
      if (m === null) throw new ParseError(i + 1);
      sec = newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      sec.hunks.push({ a: Number(m[1]), items: [], bslAfter: false });
      body = [];
      bodyRaw = [];
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = i + 1 < lines.length ? lines[i + 1] : null;
      if (next !== null && next.startsWith('+++ ')) {
        const o = headerPath(line);
        const n = headerPath(next);
        if (sec !== null && !sec.hasPair && sec.hunks.length === 0) {
          sec.hasPair = true;
          sec.pairOld = o;
          sec.pairNew = n;
        } else {
          sec = newSection();
          sec.hasPair = true;
          sec.pairOld = o;
          sec.pairNew = n;
          sections.push(sec);
        }
        i += 1;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new ParseError(i + 2);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = renamePath(line, 'rename from ');
      else if (line.startsWith('rename to ')) sec.renameTo = renamePath(line, 'rename to ');
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
    }
    // Anything else outside a body is ignored (prose, code fences, headers).
  }
  endBody();

  if (sections.length === 0) throw new ParseError(1);

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.hasPair ? s.pairOld : s.renameFrom ?? s.gitOld;
    const newP = s.hasPair ? s.pairNew : s.renameTo ?? s.gitNew;
    const isCreate = s.newFile || (s.hasPair && s.pairOld === null);
    const isDelete = s.delFile || (s.hasPair && s.pairNew === null);
    if (isCreate) {
      const path = newP ?? oldP ?? '';
      edits.push({ type: 'u-create', paths: [path], path, hunks: s.hunks });
    } else if (isDelete) {
      const path = oldP ?? newP ?? '';
      edits.push({ type: 'u-delete', paths: [path], path });
    } else {
      const o = oldP ?? newP ?? '';
      const n = newP ?? oldP ?? '';
      if (o === n) edits.push({ type: 'u-change', paths: [o], path: o, hunks: s.hunks });
      else edits.push({ type: 'u-move', paths: [o, n], from: o, to: n, hunks: s.hunks });
    }
  }
  return edits;
}

/** Apply a change or move section's hunks to a working copy of the file's lines. */
function applyHunks(
  work: string[],
  hunks: Hunk[],
  tiers: Tier[],
  path: string,
): { tail: boolean | null; fail: Fail | null } {
  let tail: boolean | null = null;
  let d = 0;
  for (const h of hunks) {
    const oTexts: string[] = [];
    for (const it of h.items) if (it.kind === 'ctx' || it.kind === 'old') oTexts.push(it.text);
    if (oTexts.length === 0) {
      const ins: string[] = [];
      for (const it of h.items) if (it.kind === 'new') ins.push(it.text);
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > work.length) pos = work.length;
      const atEnd = pos === work.length;
      spliceIn(work, pos, 0, ins);
      if (atEnd) tail = !h.bslAfter;
      d += ins.length;
    } else {
      const found = findNearest(work, oTexts, tiers, h.a - 1 + d);
      if (found === null) return { tail: null, fail: { code: 'no-match', path } };
      const built = buildNew(work, found.pos, h.items, found.tier);
      const reaches = found.pos + oTexts.length === work.length;
      spliceIn(work, found.pos, oTexts.length, built);
      if (reaches) tail = !h.bslAfter;
      d += built.length - oTexts.length;
    }
  }
  return { tail, fail: null };
}

// ------------------------------------------------------------ search/replace

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rtrim(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = trimWs(lines[j]);
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(i + 1);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (rtrim(lines[j]) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseError(i + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (rtrim(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseError(i + 1);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    if (oldLines.length === 0) edits.push({ type: 'sr-create', paths: [path], path, newLines });
    else edits.push({ type: 'sr-change', paths: [path], path, oldLines, newLines });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------- v4a

const V4A_HEADERS: [string, string][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

function v4aHeader(line: string): { kind: string; len: number } | null {
  for (const [prefix, kind] of V4A_HEADERS) {
    if (line.startsWith(prefix)) return { kind, len: prefix.length };
  }
  return null;
}

function parseV4a(lines: string[]): Edit[] {
  let fb = -1;
  let lb = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      if (fb < 0) fb = i;
      lb = i;
    }
  }
  if (fb < 0) throw new ParseError(1);
  if (trimWs(lines[fb]) !== '*** Begin Patch') throw new ParseError(fb + 1);
  const hasEnd = trimWs(lines[lb]) === '*** End Patch';
  const end = hasEnd ? lb : lines.length;

  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const header = v4aHeader(line);
    if (header === null) throw new ParseError(i + 1);
    const kind = header.kind;
    const headerNo = i + 1;
    const path = trimWs(line.slice(header.len));
    let j = i + 1;
    while (j < end && v4aHeader(lines[j]) === null) j += 1;
    const content = lines.slice(i + 1, j);
    const contentNos: number[] = [];
    for (let k = i + 1; k < j; k += 1) contentNos.push(k + 1);
    while (content.length > 0 && isBlank(content[content.length - 1])) {
      content.pop();
      contentNos.pop();
    }

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < content.length; k += 1) {
        const l = content[k];
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseError(contentNos[k]);
      }
      edits.push({ type: 'v-add', paths: [path], path, fileLines });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new ParseError(contentNos[0]);
      edits.push({ type: 'v-delete', paths: [path], path });
    } else {
      let moveTo: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (let k = 0; k < content.length; k += 1) {
        const l = content[k];
        const no = contentNos[k];
        if (k === 0 && l.startsWith('*** Move to: ')) {
          moveTo = trimWs(l.slice('*** Move to: '.length));
          continue;
        }
        if (l.startsWith('@@')) {
          const anchor = trimWs(l.slice(2));
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          chunks.push(cur);
          continue;
        }
        if (rtrim(l) === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, items: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
          continue;
        }
        const c = l.charAt(0);
        if (c === ' ' || c === '-' || c === '+' || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseError(no);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          const bkind: BodyKind = c === ' ' ? 'ctx' : c === '-' ? 'old' : c === '+' ? 'new' : 'ctx';
          cur.items.push({ kind: bkind, text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new ParseError(no);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(headerNo);
      edits.push({ type: 'v-update', paths: moveTo !== null ? [path, moveTo] : [path], path, moveTo, chunks });
    }
    i = j;
  }
  if (!hasEnd) throw new ParseError(lines.length + 1);
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------- json

function validateJsonEdit(el: unknown, lineNo: number): Edit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new ParseError(lineNo);
  const o = el as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') throw new ParseError(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(lineNo);
    return { type: 'j-create', paths: [path], path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { type: 'j-str', paths: [path], path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseError(lineNo);
    return { type: 'j-insert', paths: [path], path, line: o.insert_line, newLines: patchLines(o.new_str) };
  }
  throw new ParseError(lineNo);
}

function parseJson(text: string, lines: string[]): Edit[] {
  const firstNonWs = /\S/.exec(text);
  if (firstNonWs !== null && text[firstNonWs.index] === '[') {
    const startLine = text.slice(0, firstNonWs.index).split('\n').length;
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseError(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseError(startLine);
    if (arr.length === 0) throw new ParseError(1);
    return arr.map((el) => validateJsonEdit(el, startLine));
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (isBlank(lines[i])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(validateJsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ------------------------------------------------------------ format detect

function detectFormat(lines: string[]): string | null {
  let fb = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      fb = i;
      break;
    }
  }
  if (fb >= 0) {
    const t = trimWs(lines[fb]);
    if (t === '*** Begin Patch') return 'v4a';
    if (t.startsWith('[') || t.startsWith('{')) return 'json';
  }
  for (const l of lines) {
    if (rtrim(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------------ applying

function applyEdit(edit: Edit, tree: Tree, tiers: Tier[], moves: MoveRec[]): Fail | null {
  for (const p of edit.paths) {
    if (!isSafePath(p)) return { code: 'unsafe', path: p };
  }
  switch (edit.type) {
    case 'u-create': {
      if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
      const fileLines: string[] = [];
      const flat: BodyLine[] = [];
      for (const h of edit.hunks) {
        for (const it of h.items) {
          flat.push(it);
          if (it.kind === 'new') fileLines.push(it.text);
        }
      }
      const tail = flat.length === 0 ? true : !backslashAfter(flat);
      tree.set(edit.path, { lines: fileLines, eol: '\n', tail });
      return null;
    }
    case 'u-delete': {
      if (tree.stateNow(edit.path) === null) return { code: 'missing', path: edit.path };
      tree.set(edit.path, null);
      return null;
    }
    case 'u-change':
    case 'u-move': {
      const from = edit.type === 'u-change' ? edit.path : edit.from;
      const st = tree.stateNow(from);
      if (st === null) return { code: 'missing', path: from };
      if (edit.type === 'u-move' && tree.existsNow(edit.to)) return { code: 'exists', path: edit.to };
      const work = st.lines.slice();
      const r = applyHunks(work, edit.hunks, tiers, from);
      if (r.fail !== null) return r.fail;
      const next: FileState = { lines: work, eol: st.eol, tail: r.tail !== null ? r.tail : st.tail };
      if (edit.type === 'u-change') {
        tree.set(edit.path, next);
      } else {
        tree.set(edit.to, next);
        tree.set(edit.from, null);
        moves.push({ from: edit.from, to: edit.to });
      }
      return null;
    }
    case 'sr-create': {
      if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, { lines: edit.newLines.slice(), eol: '\n', tail: true });
      return null;
    }
    case 'sr-change': {
      const st = tree.stateNow(edit.path);
      if (st === null) return { code: 'missing', path: edit.path };
      const body: BodyLine[] = [
        ...edit.oldLines.map((t) => ({ kind: 'old' as BodyKind, text: t })),
        ...edit.newLines.map((t) => ({ kind: 'new' as BodyKind, text: t })),
      ];
      const occ = countOccurrences(st.lines, edit.oldLines, tiers, 2);
      if (occ.count === 0) return { code: 'no-match', path: edit.path };
      if (occ.count >= 2) return { code: 'ambiguous', path: edit.path };
      const work = st.lines.slice();
      const built = buildNew(work, occ.pos, body, occ.tier);
      spliceIn(work, occ.pos, edit.oldLines.length, built);
      tree.set(edit.path, { lines: work, eol: st.eol, tail: st.tail });
      return null;
    }
    case 'v-add': {
      if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, { lines: edit.fileLines.slice(), eol: '\n', tail: true });
      return null;
    }
    case 'v-delete': {
      if (tree.stateNow(edit.path) === null) return { code: 'missing', path: edit.path };
      tree.set(edit.path, null);
      return null;
    }
    case 'v-update': {
      const st = tree.stateNow(edit.path);
      if (st === null) return { code: 'missing', path: edit.path };
      if (edit.moveTo !== null && tree.existsNow(edit.moveTo)) return { code: 'exists', path: edit.moveTo };
      const work = st.lines.slice();
      let cursor = 0;
      for (const chunk of edit.chunks) {
        if (chunk.anchor !== null) {
          let foundAt = -1;
          for (const tier of tiers) {
            const want = prepTier([chunk.anchor], tier)[0];
            for (let i = cursor; i < work.length; i += 1) {
              if (lineIs(work[i], want, tier)) {
                foundAt = i;
                break;
              }
            }
            if (foundAt >= 0) break;
          }
          if (foundAt < 0) return { code: 'no-match', path: edit.path };
          cursor = foundAt + 1;
        }
        const oTexts: string[] = [];
        for (const it of chunk.items) if (it.kind === 'ctx' || it.kind === 'old') oTexts.push(it.text);
        if (oTexts.length === 0) {
          const ins: string[] = [];
          for (const it of chunk.items) if (it.kind === 'new') ins.push(it.text);
          const pos = chunk.eof ? work.length : cursor;
          spliceIn(work, pos, 0, ins);
          cursor = pos + ins.length;
        } else if (chunk.eof) {
          const pos = work.length - oTexts.length;
          let done = false;
          if (pos >= cursor) {
            for (const tier of tiers) {
              const po = prepTier(oTexts, tier);
              if (matchAt(work, pos, po, tier)) {
                const built = buildNew(work, pos, chunk.items, tier);
                spliceIn(work, pos, oTexts.length, built);
                cursor = pos + built.length;
                done = true;
                break;
              }
            }
          }
          if (!done) return { code: 'no-match', path: edit.path };
        } else {
          const found = findForward(work, oTexts, tiers, cursor);
          if (found === null) return { code: 'no-match', path: edit.path };
          const built = buildNew(work, found.pos, chunk.items, found.tier);
          spliceIn(work, found.pos, oTexts.length, built);
          cursor = found.pos + built.length;
        }
      }
      const next: FileState = { lines: work, eol: st.eol, tail: st.tail };
      if (edit.moveTo !== null) {
        tree.set(edit.moveTo, next);
        tree.set(edit.path, null);
        moves.push({ from: edit.path, to: edit.moveTo });
      } else {
        tree.set(edit.path, next);
      }
      return null;
    }
    case 'j-create': {
      if (tree.existsNow(edit.path)) return { code: 'exists', path: edit.path };
      tree.set(edit.path, parseText(edit.text));
      return null;
    }
    case 'j-str': {
      const st = tree.stateNow(edit.path);
      if (st === null) return { code: 'missing', path: edit.path };
      const crlf = st.eol === '\r\n';
      let work = printText(st);
      let oldStr = edit.oldStr;
      let newStr = edit.newStr;
      if (crlf) {
        work = work.replaceAll('\r\n', '\n');
        oldStr = oldStr.replaceAll('\r\n', '\n');
        newStr = newStr.replaceAll('\r\n', '\n');
      }
      const first = work.indexOf(oldStr);
      if (first < 0) return { code: 'no-match', path: edit.path };
      if (work.indexOf(oldStr, first + 1) >= 0) return { code: 'ambiguous', path: edit.path };
      let result = work.slice(0, first) + newStr + work.slice(first + oldStr.length);
      if (crlf) result = result.replaceAll('\n', '\r\n');
      tree.set(edit.path, parseText(result));
      return null;
    }
    case 'j-insert': {
      const st = tree.stateNow(edit.path);
      if (st === null) return { code: 'missing', path: edit.path };
      if (edit.line < 0 || edit.line > st.lines.length) return { code: 'no-match', path: edit.path };
      const work = st.lines.slice();
      spliceIn(work, edit.line, 0, edit.newLines.slice());
      tree.set(edit.path, { lines: work, eol: st.eol, tail: st.tail });
      return null;
    }
  }
}

// ----------------------------------------------------------------------- run

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function run(argv: string[]): { code: number; out: string[] } {
  let format = 'auto';
  let check = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let endOpts = false;
  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seen.has('check')) return { code: 2, out: ['error: usage'] };
        seen.add('check');
        check = true;
      } else if (arg === '--strict') {
        if (seen.has('strict')) return { code: 2, out: ['error: usage'] };
        seen.add('strict');
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('format')) return { code: 2, out: ['error: usage'] };
        seen.add('format');
        const v = arg.slice('--format='.length);
        if (!FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  let patchText: string;
  if (positional.length === 0 || positional[0] === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(positional[0], 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = patchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  const tree = new Tree();
  const moves: MoveRec[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const f = applyEdit(edit, tree, tiers, moves);
    if (f !== null) fails.push(f);
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: { key: string; line: string }[] = [];
  const inR = new Set<string>();
  for (const mv of moves) {
    const bOld = tree.beforeText(mv.from);
    const aOld = tree.finalText(mv.from);
    const bNew = tree.beforeText(mv.to);
    const aNew = tree.finalText(mv.to);
    if (bOld !== null && aOld === null && bNew === null && aNew !== null) {
      rows.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      inR.add(mv.from);
      inR.add(mv.to);
    }
  }
  for (const p of tree.touched()) {
    if (inR.has(p)) continue;
    const b = tree.beforeText(p);
    const a = tree.finalText(p);
    if (b === a) continue;
    rows.push({ key: p, line: `${b === null ? 'A' : a === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!check) {
    for (const p of tree.touched()) {
      const b = tree.beforeText(p);
      const a = tree.finalText(p);
      if (b === a) continue;
      if (a === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, a);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
