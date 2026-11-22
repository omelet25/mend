// mend: the CLI SPEC.md specifies. Based on the kit's starter (MIT): sections 1-4, 9 and 10
// (command line, output and exit codes, safe paths, format detection, JSON edits, all-or-nothing
// write) come from the starter; sections 5 (three-tier line matching), 6 (unified diffs),
// 7 (SEARCH/REPLACE) and 8 (V4A) are implemented here. Node 22, standard library alone.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- section 3: a file as lines ----------

interface FileLines {
  lines: string[];
  br: string; // '\r\n' or '\n'
  final: boolean; // ends with a line break
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---------- section 5: matching lines at three tiers ----------

type Item = { kind: 'ctx' | 'del' | 'add'; text: string; slash?: boolean };

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const strip = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function norm(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? rstrip(s) : strip(s);
}

/** Occurrences of O in lines at the first tier that has one, searching from `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; at: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const at: number[] = [];
    const no = o.map((s) => norm(s, tier));
    for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (norm(lines[i + j]!, tier) !== no[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** The lines a replacement writes: context lines are the file's own; at tier 2, added lines are re-indented. */
function replacement(fileLines: string[], pos: number, items: Item[], tier: number): string[] {
  const out: string[] = [];
  let oi = 0; // index into the matched segment for ctx/del items
  const oFirst = items.find((it) => it.kind !== 'add');
  const fLead = fileLines[pos] !== undefined ? leadWs(fileLines[pos]!) : '';
  const pLead = oFirst !== undefined ? leadWs(oFirst.text) : '';
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (it.kind === 'del') {
      oi++;
    } else {
      let t = it.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
      out.push(t);
    }
  }
  return out;
}

function mustExist(tree: Tree, p: string): string {
  const t = tree.get(p);
  if (t === null) throw new Fail('missing', p);
  return t;
}

// ---------- section 6: unified diffs ----------

interface Hunk {
  a: number;
  items: Item[];
}

interface Section {
  oldPath: string | null; // null: /dev/null or unnamed
  newPath: string | null;
  gitOld: string | null;
  gitNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: Hunk[];
}

function headerPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let inHunks = false;
  let i = 0;
  const startsSection = (idx: number): boolean =>
    lines[idx]!.startsWith('diff --git ') || (lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ '));
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldPath: null, newPath: null, gitOld: m[1]!, gitNew: m[2]!, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
      sections.push(sec);
      inHunks = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && (sec === null || inHunks)) {
      sec = { oldPath: null, newPath: null, gitOld: null, gitNew: null, renameFrom: null, renameTo: null, isNew: false, isDel: false, hunks: [] };
      sections.push(sec);
      inHunks = false;
      // fall through: this --- line is the new section's header
    }
    if (sec === null) {
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (!inHunks) {
      // section header
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        const p = headerPath(line.slice(4));
        sec.oldPath = p === '/dev/null' ? null : p;
        i++;
        const q = headerPath(lines[i]!.slice(4));
        sec.newPath = q === '/dev/null' ? null : q;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isNew = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDel = true;
        i++;
        continue;
      }
      if (!line.startsWith('@@')) {
        i++; // index, modes, prose: ignored
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHunks = true;
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      i++;
      // body
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c = b[0];
        if (b === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          if (c === '\\') {
            const prev = hunk.items[hunk.items.length - 1];
            if (prev !== undefined) prev.slash = true;
          } else if (b === '') hunk.items.push({ kind: 'ctx', text: '' });
          else hunk.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: b.slice(1) });
          i++;
          continue;
        }
        break;
      }
      // empty lines at the end of a body are not part of it
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '' && !last.slash) hunk.items.pop();
        else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(sec: Section): Edit {
  return (tree) => {
    const oldP = sec.oldPath ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.newPath ?? sec.renameTo ?? sec.gitNew;
    // creation is: old path /dev/null (oldPath null while a +++ named a file) or `new file mode`
    const isCreate = sec.isNew || (sec.oldPath === null && sec.newPath !== null);
    const isDelete = sec.isDel || (sec.newPath === null && sec.oldPath !== null);
    if (isCreate) {
      const p = newP;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastSlash = false;
      for (const h of sec.hunks) {
        for (const it of h.items) {
          if (it.kind === 'add') {
            out.push(it.text);
            lastSlash = it.slash === true;
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (lastSlash ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    // change or move
    const src = oldP;
    const dst = newP;
    if (src === null || dst === null) throw new Fail('missing', src ?? dst ?? '');
    if (!safe(src)) throw new Fail('unsafe', src);
    if (!safe(dst)) throw new Fail('unsafe', dst);
    const before = mustExist(tree, src);
    const isMove = src !== dst;
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const oItems = h.items.filter((it) => it.kind !== 'add');
      const nItems = h.items.filter((it) => it.kind !== 'del');
      const o = oItems.map((it) => it.text);
      if (o.length === 0) {
        const pos = Math.min(h.a + d, f.lines.length);
        const addLines = nItems.map((it) => it.text);
        f.lines.splice(pos, 0, ...addLines);
        if (pos + addLines.length === f.lines.length && addLines.length > 0) {
          const lastAdd = nItems[nItems.length - 1];
          if (lastAdd !== undefined) f.final = lastAdd.slash !== true;
        }
      } else {
        const found = findTier(f.lines, o, STRICT);
        if (found === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let pos = found.at[0]!;
        for (const cand of found.at) {
          if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        }
        const runsToEnd = pos + o.length === f.lines.length;
        const rep = replacement(f.lines, pos, h.items, found.tier);
        f.lines.splice(pos, o.length, ...rep);
        if (runsToEnd) {
          const lastCp = [...h.items].reverse().find((it) => it.kind === 'ctx' || it.kind === 'add');
          if (lastCp !== undefined) f.final = lastCp.slash !== true;
        }
      }
      d += nItems.length - oItems.length;
    }
    tree.now.set(dst, joinFile(f));
    if (isMove) {
      tree.now.set(src, null);
      tree.moves.push([src, dst]);
    }
  };
}

// ---------- section 7: SEARCH/REPLACE ----------

function parseSearchReplace(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldL: string[];
    newL: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // lines before this index belong to earlier blocks
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // path: nearest line before SEARCH, after the previous block, not blank, not a fence
    let p: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine}`);
    // find ======= then >>>>>>> REPLACE
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rp = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rp = j;
          break;
        }
      }
    }
    if (eq < 0 || rp < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path: p, oldL: lines.slice(i + 1, eq), newL: lines.slice(eq + 1, rp) });
    prevPath = p;
    searchFrom = rp + 1;
    i = rp + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.oldL.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, b.newL.length === 0 ? '' : b.newL.join('\n') + '\n');
          return;
        }
        const before = mustExist(tree, b.path);
        const f = splitFile(before);
        const found = findTier(f.lines, b.oldL, STRICT);
        if (found === null) throw new Fail('no-match', b.path);
        if (found.at.length > 1) throw new Fail('ambiguous', b.path);
        const pos = found.at[0]!;
        const items: Item[] = [
          ...b.oldL.map((t): Item => ({ kind: 'del', text: t })),
          ...b.newL.map((t): Item => ({ kind: 'add', text: t })),
        ];
        // replacement() walks items in order; dels and adds are separate runs, so build directly:
        const rep: string[] = [];
        const fLead = f.lines[pos] !== undefined ? leadWs(f.lines[pos]!) : '';
        const pLead = leadWs(b.oldL[0]!);
        for (const t of b.newL) {
          let x = t;
          if (found.tier === 2 && x.trim() !== '' && x.startsWith(pLead)) x = fLead + x.slice(pLead.length);
          rep.push(x);
        }
        void items;
        f.lines.splice(pos, b.oldL.length, ...rep);
        tree.now.set(b.path, joinFile(f));
      },
  );
}

// ---------- section 8: V4A ----------

function parseV4a(lines: string[]): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      lastIdx = j;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Chunk {
    anchor: string | null;
    eof: boolean;
    items: Item[];
  }
  interface VSection {
    kind: 'add' | 'del' | 'update';
    path: string;
    line: number;
    moveTo: string | null;
    addLines: string[];
    chunks: Chunk[];
  }
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: Chunk | null = null;
  const secStart = (l: string): { kind: VSection['kind']; path: string } | null => {
    if (l.startsWith('*** Add File: ')) return { kind: 'add', path: l.slice(14).trim() };
    if (l.startsWith('*** Delete File: ')) return { kind: 'del', path: l.slice(17).trim() };
    if (l.startsWith('*** Update File: ')) return { kind: 'update', path: l.slice(17).trim() };
    return null;
  };
  for (let idx = firstIdx + 1; idx < lastIdx; idx++) {
    const line = lines[idx]!;
    const st = secStart(line);
    if (st !== null) {
      cur = { ...st, line: idx + 1, moveTo: null, addLines: [], chunks: [] };
      sections.push(cur);
      chunk = null;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else if (line === '') cur.addLines.push('');
      else throw new Exit2(`error: parse ${idx + 1}`);
      continue;
    }
    if (cur.kind === 'del') {
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    // update
    if (line.startsWith('*** Move to: ') && cur.chunks.length === 0 && chunk === null && cur.moveTo === null) {
      cur.moveTo = line.slice(13).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, items: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, eof: true, items: [] };
        cur.chunks.push(chunk);
      } else chunk.eof = true;
      // the chunk ends; a following body line starts a new chunk
      chunk = { anchor: null, eof: false, items: [] };
      cur.chunks.push(chunk);
      continue;
    }
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, items: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.items.push({ kind: 'ctx', text: '' });
      else chunk.items.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'del' : 'add', text: line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  // tidy: drop the empty trailing chunk an End of File line may have opened, trim trailing
  // blank body lines of each section's last chunk, drop trailing blank Add lines
  for (const s of sections) {
    while (s.chunks.length > 0) {
      const last = s.chunks[s.chunks.length - 1]!;
      if (last.items.length === 0 && last.anchor === null && !last.eof) s.chunks.pop();
      else break;
    }
    const last = s.chunks[s.chunks.length - 1];
    if (last !== undefined) {
      while (last.items.length > 0) {
        const it = last.items[last.items.length - 1]!;
        if (it.kind === 'ctx' && it.text === '') last.items.pop();
        else break;
      }
    }
    while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1] === '') s.addLines.pop();
    if (s.kind === 'update' && s.chunks.length === 0 && s.moveTo === null) throw new Exit2(`error: parse ${s.line}`);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map(
    (s): Edit =>
      (tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (s.kind === 'add') {
          if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
          tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
          return;
        }
        if (s.kind === 'del') {
          if (tree.get(s.path) === null) throw new Fail('missing', s.path);
          tree.now.set(s.path, null);
          return;
        }
        // update
        if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
        const before = mustExist(tree, s.path);
        if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
        const f = splitFile(before);
        let cursor = 0;
        for (const ch of s.chunks) {
          if (ch.anchor !== null) {
            const foundA = findTier(f.lines, [ch.anchor], STRICT, cursor);
            if (foundA === null) throw new Fail('no-match', s.path);
            cursor = foundA.at[0]! + 1;
          }
          const oItems = ch.items.filter((it) => it.kind !== 'add');
          const nItems = ch.items.filter((it) => it.kind !== 'del');
          const o = oItems.map((it) => it.text);
          if (o.length === 0) {
            const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
            const rep = replacement(f.lines, pos, ch.items, 0);
            f.lines.splice(pos, 0, ...rep);
            cursor = pos + rep.length;
          } else {
            const found = findTier(f.lines, o, STRICT, cursor);
            if (found === null) throw new Fail('no-match', s.path);
            let candidates = found.at;
            if (ch.eof) candidates = candidates.filter((p) => p + o.length === f.lines.length);
            if (candidates.length === 0) throw new Fail('no-match', s.path);
            const pos = candidates[0]!;
            const rep = replacement(f.lines, pos, ch.items, found.tier);
            f.lines.splice(pos, o.length, ...rep);
            cursor = pos + rep.length;
          }
        }
        const dst = s.moveTo ?? s.path;
        tree.now.set(dst, joinFile(f));
        if (s.moveTo !== null) {
          tree.now.set(s.path, null);
          tree.moves.push([s.path, s.moveTo]);
        }
      },
  );
}

// ---------- format detection (section 4, from the starter) ----------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------- section 9: JSON edits (from the starter) ----------

let STRICT = false;

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
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
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- invocation, output, atomicity (sections 1, 2, 10) ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  STRICT = strict;
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4a(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with a qualified move pair shown as one R line (section 2).
  const finalGet = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const rPairs = new Map<string, string>(); // new -> old
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && finalGet(o) === null && tree.original(n) === null && finalGet(n) !== null) rPairs.set(n, o);
  }
  const rOlds = new Set(rPairs.values());
  const rows: Array<{ key: string; line: string; path: string; now: string | null }> = [];
  for (const p of tree.now.keys()) {
    if (rOlds.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rPairs.has(p)) rows.push({ key: p, line: `R ${rPairs.get(p)!} -> ${p}`, path: p, now });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, path: p, now });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) {
      if (rPairs.has(r.path)) {
        // a move: write the new path, remove the old
        const old = rPairs.get(r.path)!;
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.now!);
        rmSync(old, { force: true });
      } else if (r.now === null) rmSync(r.path, { force: true });
      else {
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, r.now);
      }
    }
    // paths only in `now` that produced no row cannot exist; deletions of moved-from paths are handled above.
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
