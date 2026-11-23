// mend: one patch tool for every AI edit format (SPEC.md version 1).
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines
// each edit names at the first of three matching tiers, and writes every change or none, printing what changed
// or why it failed. Node 22 and its standard library alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines of this file then hand
// over to runner.ts, which runs this CLI on each check in a fresh directory without that variable.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------- errors

/** An exit-2 failure: exactly one line on stdout. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------- text and files

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a path is safe when it is relative, holds no backslash and no empty, `.` or `..` segment. */
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function checkSafe(p: string): void {
  if (!safePath(p)) throw new Fail('unsafe', p);
}

interface FileText {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

/** Split a file's text at its own line break (CRLF when its first line feed follows a carriage return). */
function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let finalBreak = false;
  if (text.endsWith(br)) {
    lines.pop();
    finalBreak = true;
  }
  return { br, lines, finalBreak };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

// ---------------------------------------------------------------- the tree

/** The tree as the edits leave it: `now` holds the paths edits touched (null: deleted); the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

function needFile(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---------------------------------------------------------------- matching lines (section 5)

const NORMS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every position at which pat occurs in lines under one tier's comparison; occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const norm = NORMS[tier] as (s: string) => string;
  const nl = lines.map(norm);
  const np = pat.map(norm);
  const res: number[] = [];
  for (let i = 0; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (nl[i + j] !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which pat occurs at least once, with every occurrence there. */
function findLines(lines: string[], pat: string[], strict: boolean): Found | null {
  for (const t of tiersToTry(strict)) {
    const occ = occurrences(lines, pat, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? (m[0] as string) : '';
}

/**
 * Replace lines[pos .. pos+o.length) with n. nFromO[j] is the index into o when n[j] is a context line (written
 * as the file's own matched line), else -1. At tier 2 every other line of n is re-indented: its leading P (the
 * first old line's indent) becomes F (the file's first matched line's indent), when it starts with P.
 */
function splice(lines: string[], pos: number, o: string[], n: string[], nFromO: number[], tier: number): string[] {
  const out = lines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadOf(lines[pos] as string);
    p = leadOf(o[0] as string);
  }
  for (let j = 0; j < n.length; j += 1) {
    const from = nFromO[j] as number;
    if (from >= 0) {
      out.push(lines[pos + from] as string);
      continue;
    }
    let t = n[j] as string;
    if (tier === 2 && o.length > 0 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  for (let i = pos + o.length; i < lines.length; i += 1) out.push(lines[i] as string);
  return out;
}

/** One line of a unified hunk body or a V4A chunk body. `blank`: the patch line was empty; `ws`: it was only whitespace. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noBreak: boolean;
  blank: boolean;
  ws: boolean;
}

/** Split body lines into old lines, new lines and, for each new line, its old index when it is a context line. */
function bodyParts(body: BodyLine[]): { o: string[]; n: string[]; nFromO: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nFromO: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
      nFromO.push(o.length - 1);
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else {
      n.push(b.text);
      nFromO.push(-1);
    }
  }
  return { o, n, nFromO };
}

/** Whether a `\` line follows the body's last context or `+` line (its noBreak flag). */
function lastNoBreak(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k] as BodyLine;
    if (b.kind !== 'del') return b.noBreak;
  }
  return false;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { diffOld: null, diffNew: null, hdrOld: null, hdrNew: null, renFrom: null, renTo: null, isNew: false, isDel: false, hunks: [] };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let header = false; // the current section is before its first hunk
  const startsPair = (i: number): boolean =>
    (lines[i] as string).startsWith('--- ') && ((lines[i + 1] ?? '') as string).startsWith('+++ ');
  const pathOf = (line: string): string => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  const stripPrefix = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.startsWith('diff --git ')) {
      const m = /^a\/(.*?) b\/(.*)$/.exec(line.slice(11));
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.diffOld = m[1] as string;
      sec.diffNew = m[2] as string;
      sections.push(sec);
      header = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (startsPair(i)) {
        if (sec !== null && header && sec.hdrOld === null) {
          sec.hdrOld = stripPrefix(pathOf(line));
          sec.hdrNew = stripPrefix(pathOf(lines[i + 1] as string));
        } else {
          sec = newSection();
          sec.hdrOld = stripPrefix(pathOf(line));
          sec.hdrNew = stripPrefix(pathOf(lines[i + 1] as string));
          sections.push(sec);
          header = true;
        }
        i += 2;
        continue;
      }
      if (sec !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (sec !== null && header) {
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        i += 1;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      const hunk: Hunk = { a: parseInt(m[1] as string, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i] as string;
        if (bl.startsWith('diff --git ')) break;
        if (startsPair(i)) break;
        const c = bl.charAt(0);
        if (bl === '') {
          hunk.body.push({ kind: 'ctx', text: '', noBreak: false, blank: true, ws: true });
        } else if (c === ' ') {
          hunk.body.push({ kind: 'ctx', text: bl.slice(1), noBreak: false, blank: false, ws: bl.trim() === '' });
        } else if (c === '-') {
          hunk.body.push({ kind: 'del', text: bl.slice(1), noBreak: false, blank: false, ws: false });
        } else if (c === '+') {
          hunk.body.push({ kind: 'add', text: bl.slice(1), noBreak: false, blank: false, ws: false });
        } else if (c === '\\') {
          const last = hunk.body[hunk.body.length - 1];
          if (last) last.noBreak = true;
        } else {
          break;
        }
        i += 1;
      }
      while (hunk.body.length > 0 && (hunk.body[hunk.body.length - 1] as BodyLine).blank) hunk.body.pop();
      sec.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = sec.hdrOld ?? sec.renFrom ?? sec.diffOld;
    const newRaw = sec.hdrNew ?? sec.renTo ?? sec.diffNew;
    const creation = sec.isNew || oldRaw === '/dev/null';
    const deletion = sec.isDel || newRaw === '/dev/null';
    if (creation) {
      const p = newRaw as string;
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let addNoBreak = false;
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === 'add') {
            out.push(b.text);
            addNoBreak = b.noBreak;
          }
        }
      }
      tree.set(p, out.length === 0 ? '' : out.join('\n') + (addNoBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldRaw as string;
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    const oldP = oldRaw as string;
    const newP = (newRaw ?? oldRaw) as string;
    checkSafe(oldP);
    if (newP !== oldP) checkSafe(newP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    if (newP !== oldP && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n, nFromO } = bodyParts(h.body);
      const noBreak = lastNoBreak(h.body);
      if (o.length === 0) {
        const pos = Math.min(h.a + d, f.lines.length);
        const atEnd = pos === f.lines.length;
        f.lines = [...f.lines.slice(0, pos), ...n, ...f.lines.slice(pos)];
        if (atEnd && n.length > 0) f.finalBreak = !noBreak;
        d += n.length;
        continue;
      }
      const found = findLines(f.lines, o, strict);
      if (!found) throw new Fail('no-match', oldP);
      const target = h.a - 1 + d;
      let pos = found.occ[0] as number;
      for (const cand of found.occ) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const runsToEnd = pos + o.length === f.lines.length;
      f.lines = splice(f.lines, pos, o, n, nFromO, found.tier);
      if (runsToEnd) f.finalBreak = !noBreak;
      d += n.length - o.length;
    }
    tree.set(newP, joinFile(f));
    if (newP !== oldP) {
      tree.set(oldP, null);
      tree.moves.push([oldP, newP]);
    }
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j >= searchFrom; j -= 1) {
      const l = lines[j] as string;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${at + 1}`);
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if ((lines[j] as string).trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if ((lines[j] as string).trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    checkSafe(b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const f = splitFile(needFile(tree, b.path));
    const found = findLines(f.lines, b.oldLines, strict);
    if (!found) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const nFromO = b.newLines.map(() => -1);
    f.lines = splice(f.lines, found.occ[0] as number, b.oldLines, b.newLines, nFromO, found.tier);
    tree.set(b.path, joinFile(f));
  };
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  startLine: number;
}

const afterPrefix = (line: string, prefix: string): string => line.slice(prefix.length).trim();

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const sec: VSection = { kind: 'add', path: afterPrefix(line, '*** Add File: '), addLines: [], moveTo: null, chunks: [], startLine: i + 1 };
      i += 1;
      const src: Array<{ text: string; blank: boolean; at: number }> = [];
      while (i < last) {
        const l = lines[i] as string;
        if (l.startsWith('*** ')) break;
        if (l.startsWith('+')) src.push({ text: l.slice(1), blank: false, at: i + 1 });
        else if (l === '') src.push({ text: '', blank: true, at: i + 1 });
        else if (l.trim() === '') src.push({ text: l, blank: true, at: i + 1 });
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (src.length > 0 && (src[src.length - 1] as { blank: boolean }).blank) src.pop();
      for (const s of src) {
        // A whitespace-only line that is not at the section's end is not a file line: the section is malformed there.
        if (s.blank && s.text !== '') throw new Exit2(`error: parse ${s.at}`);
      }
      sec.addLines = src.map((s) => s.text);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      sections.push({ kind: 'del', path: afterPrefix(line, '*** Delete File: '), addLines: [], moveTo: null, chunks: [], startLine: i + 1 });
      i += 1;
      while (i < last) {
        const l = lines[i] as string;
        if (l.startsWith('*** ')) break;
        if (isBlank(l)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const sec: VSection = { kind: 'upd', path: afterPrefix(line, '*** Update File: '), addLines: [], moveTo: null, chunks: [], startLine: i + 1 };
      i += 1;
      if (i < last && (lines[i] as string).startsWith('*** Move to: ')) {
        sec.moveTo = afterPrefix(lines[i] as string, '*** Move to: ');
        i += 1;
      }
      let chunk: VChunk | null = null;
      while (i < last) {
        const l = lines[i] as string;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(chunk);
          i += 1;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk) {
            chunk.eof = true;
            chunk = null;
          }
          i += 1;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        const c = l.charAt(0);
        if (l === '' || c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          if (l === '') chunk.body.push({ kind: 'ctx', text: '', noBreak: false, blank: true, ws: true });
          else
            chunk.body.push({
              kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add',
              text: l.slice(1),
              noBreak: false,
              blank: false,
              ws: l.trim() === '',
            });
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      // Blank lines at the end of a section are not part of it: drop the last chunk's trailing whitespace-only lines.
      const lc = sec.chunks[sec.chunks.length - 1];
      if (lc) {
        while (lc.body.length > 0 && (lc.body[lc.body.length - 1] as BodyLine).ws) lc.body.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.startLine}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return sections;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    checkSafe(sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    if (sec.moveTo !== null) checkSafe(sec.moveTo);
    const text = tree.get(sec.path);
    if (text === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const { o, n, nFromO } = bodyParts(ch.body);
      if (ch.anchor !== null) {
        let at = -1;
        for (const t of tiersToTry(strict)) {
          const norm = NORMS[t] as (s: string) => string;
          const na = norm(ch.anchor);
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (norm(f.lines[k] as string) === na) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines = [...f.lines.slice(0, pos), ...n, ...f.lines.slice(pos)];
        cursor = pos + n.length;
        continue;
      }
      if (ch.eof) {
        const pos = f.lines.length - o.length;
        let tierUsed = -1;
        if (pos >= cursor) {
          for (const t of tiersToTry(strict)) {
            if (occurrences(f.lines, o, t).includes(pos)) {
              tierUsed = t;
              break;
            }
          }
        }
        if (tierUsed < 0) throw new Fail('no-match', sec.path);
        f.lines = splice(f.lines, pos, o, n, nFromO, tierUsed);
        cursor = pos + n.length;
        continue;
      }
      let done = false;
      for (const t of tiersToTry(strict)) {
        const occ = occurrences(f.lines, o, t).filter((x) => x >= cursor);
        if (occ.length > 0) {
          const pos = occ[0] as number;
          f.lines = splice(f.lines, pos, o, n, nFromO, t);
          cursor = pos + n.length;
          done = true;
          break;
        }
      }
      if (!done) throw new Fail('no-match', sec.path);
    }
    const dest = sec.moveTo ?? sec.path;
    tree.set(dest, joinFile(f));
    if (sec.moveTo !== null) {
      tree.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object, or null when it is not one (a parse fault). */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      checkSafe(p);
      const before = needFile(tree, p);
      const crlf = splitFile(before).br === '\r\n';
      const lf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      checkSafe(p);
      const f = splitFile(needFile(tree, p));
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.set(p, joinFile(f));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- detecting the format (section 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let k = 0; k < lines.length; k += 1) {
    const l = lines[k] as string;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && ((lines[k + 1] ?? '') as string).startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------- the run (sections 1, 2 and 10)

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) {
        format = a.slice(9);
        continue;
      }
      if (a === '--check' && !checkOnly) {
        checkOnly = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchPath = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) return { code: 2, out: ['error: no-patch'] };
    text = '';
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => srEdit(b, strict));
    else edits = parseV4a(lines).map((s) => v4aEdit(s, strict));
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const savedNow = new Map(tree.now);
    const savedMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of savedNow) tree.now.set(k, v);
      tree.moves.length = savedMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const kinds = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    kinds.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (kinds.get(o) === 'D' && kinds.get(n) === 'A' && !used.has(o) && !used.has(n)) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      used.add(o);
      used.add(n);
    }
  }
  for (const [p, k] of kinds) {
    if (used.has(p)) continue;
    rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!checkOnly) {
    for (const p of kinds.keys()) {
      const now = tree.now.get(p) as string | null;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
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
