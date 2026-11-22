// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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
  /** Successful moves, as (old, new) pairs, for the `R` output lines. */
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

/** A file's text as lines, its line break, and whether it ends with one (SPEC.md section 3). */
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Positions where O occurs in lines at tier; occurrences may overlap (SPEC.md section 5). */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = 0; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (!lineEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs (tier 0 only when strict), with its positions. */
function findTier(lines: string[], old: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One added line of N, re-indented at tier 2 (SPEC.md section 5). */
function reindent(line: string, tier: number, p: string, f: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}
interface Hunk {
  a: number;
  body: HunkLine[];
}
interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- `/`+++ `: up to the first tab, surrounding spaces removed. */
function diffPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function isBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\';
}

/** The sections of a unified diff (SPEC.md section 6). */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let seenPair = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffOld: m[1], diffNew: m[2], dashOld: undefined, dashNew: undefined, renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      seenPair = false;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (cur !== null && inHeader && !seenPair) {
          cur.dashOld = diffPath(l);
          cur.dashNew = diffPath(lines[i + 1]!);
          seenPair = true;
        } else {
          cur = { diffOld: undefined, diffNew: undefined, dashOld: diffPath(l), dashNew: diffPath(lines[i + 1]!), renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hunks: [] };
          sections.push(cur);
          inHeader = true;
          seenPair = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_RE.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: HunkLine[] = [];
      let j = i + 1;
      while (j < n && isBodyLine(lines[j]!)) {
        if (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const bl = lines[j]!;
        body.push({ kind: bl === '' ? ' ' : (bl[0] as HunkLine['kind']), text: bl === '' ? '' : bl.slice(1), empty: bl === '' });
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line (SPEC.md section 6). */
function hunkNoEol(h: Hunk): boolean {
  for (let k = h.body.length - 1; k >= 0; k -= 1) {
    const b = h.body[k]!;
    if (b.kind === ' ' || b.kind === '+') return h.body[k + 1]?.kind === '\\';
  }
  return false;
}

/** Whether a `\` line follows the last `+` line of a section's hunks. */
function sectionCreateNoEol(hunks: Hunk[]): boolean {
  for (let hi = hunks.length - 1; hi >= 0; hi -= 1) {
    const h = hunks[hi]!;
    for (let k = h.body.length - 1; k >= 0; k -= 1) {
      if (h.body[k]!.kind === '+') return h.body[k + 1]?.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  let { lines, br, final } = fileLines(before);
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const nParts: Array<{ text: string; ctx: boolean; oIdx: number }> = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        const idx = o.length;
        o.push(b.text);
        nParts.push({ text: b.text, ctx: true, oIdx: idx });
      } else if (b.kind === '-') {
        o.push(b.text);
      } else if (b.kind === '+') {
        nParts.push({ text: b.text, ctx: false, oIdx: -1 });
      }
    }
    const noEol = hunkNoEol(h);
    if (o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines = [...lines.slice(0, at), ...nParts.map((p) => p.text), ...lines.slice(at)];
      if (atEnd) final = !noEol;
      d += nParts.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const p = leadST(o[0]!);
    const f = leadST(lines[best]!);
    const repl = nParts.map((np) => (np.ctx ? lines[best + np.oIdx]! : reindent(np.text, found.tier, p, f)));
    const runsToEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
    if (runsToEnd) final = !noEol;
    d += nParts.length - o.length;
  }
  return joinLines(lines, br, final);
}

/** One section is one edit (SPEC.md section 6). */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.dashOld !== undefined ? s.dashOld : (s.renameFrom ?? s.diffOld ?? null);
  const newPath = s.dashNew !== undefined ? s.dashNew : (s.renameTo ?? s.diffNew ?? null);
  if (oldPath === null && newPath === null) return () => {};
  const isCreate = oldPath === null || s.newFile;
  const isDelete = !isCreate && (newPath === null || s.deletedFile);
  if (isCreate && newPath !== null) {
    const p = newPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (sectionCreateNoEol(s.hunks) ? '' : '\n'));
    };
  }
  if (isDelete && oldPath !== null) {
    const p = oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    const op = oldPath;
    const np = newPath;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, out);
      tree.moves.push([op, np]);
    };
  }
  if (oldPath !== null) {
    const p = oldPath;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      tree.now.set(p, applyHunks(before, s.hunks, strict, p));
    };
  }
  return () => {};
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => sectionEdit(s, strict));
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** One SEARCH/REPLACE block is one edit (SPEC.md section 7). */
function srEdit(b: SRBlock, strict: boolean): Edit {
  const p = b.path;
  const oldLines = b.oldLines;
  const newLines = b.newLines;
  if (oldLines.length === 0) {
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
    };
  }
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const { lines, br, final } = fileLines(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.at.length > 1) throw new Fail('ambiguous', p);
    const at = found.at[0]!;
    const lead = leadST(oldLines[0]!);
    const fileLead = leadST(lines[at]!);
    const repl = newLines.map((l) => reindent(l, found.tier, lead, fileLead));
    const out = [...lines.slice(0, at), ...repl, ...lines.slice(at + oldLines.length)];
    tree.now.set(p, joinLines(out, br, final));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}
interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  moveTo?: string;
  addLines: string[];
  chunks: V4AChunk[];
}

/** First tier with an occurrence of O at or after `from` (SPEC.md sections 5 and 8). */
function findTierFrom(lines: string[], old: string[], from: number, strict: boolean, eof = false): { tier: number; at: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrences(lines, old, t).filter((i) => i >= from && (!eof || i + old.length === lines.length));
    if (at.length > 0) return { tier: t, at: at[0]! };
  }
  return null;
}

/** Apply a V4A section's chunks in order to a file's text (SPEC.md section 8). */
function applyV4AChunks(before: string, chunks: V4AChunk[], strict: boolean, failPath: string): string {
  let { lines, br, final } = fileLines(before);
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const a = findTierFrom(lines, [c.anchor], cursor, strict);
      if (a === null) throw new Fail('no-match', failPath);
      cursor = a.at + 1;
    }
    const o: string[] = [];
    const nParts: Array<{ text: string; ctx: boolean; oIdx: number }> = [];
    for (const b of c.body) {
      if (b.kind === ' ') {
        const idx = o.length;
        o.push(b.text);
        nParts.push({ text: b.text, ctx: true, oIdx: idx });
      } else if (b.kind === '-') {
        o.push(b.text);
      } else {
        nParts.push({ text: b.text, ctx: false, oIdx: -1 });
      }
    }
    if (o.length === 0) {
      const at = c.eof ? lines.length : cursor;
      lines = [...lines.slice(0, at), ...nParts.map((p) => p.text), ...lines.slice(at)];
      cursor = at + nParts.length;
      continue;
    }
    const found = findTierFrom(lines, o, cursor, strict, c.eof);
    if (found === null) throw new Fail('no-match', failPath);
    const at = found.at;
    const p = leadST(o[0]!);
    const f = leadST(lines[at]!);
    const repl = nParts.map((np) => (np.ctx ? lines[at + np.oIdx]! : reindent(np.text, found.tier, p, f)));
    lines = [...lines.slice(0, at), ...repl, ...lines.slice(at + o.length)];
    cursor = at + repl.length;
  }
  return joinLines(lines, br, final);
}

const V4A_MARKERS = [
  ['*** Add File:', 'add'],
  ['*** Delete File:', 'delete'],
  ['*** Update File:', 'update'],
] as const;

function v4aSectionStart(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  for (const [marker, kind] of V4A_MARKERS) {
    if (l === marker || l.startsWith(marker + ' ')) return { kind, path: l.slice(marker.length).trim() };
  }
  return null;
}

/** Parse a V4A patch into sections (SPEC.md section 8). */
function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  interface RawSection { kind: 'add' | 'delete' | 'update'; path: string; headerLine: number; raw: Array<{ text: string; num: number }>; }
  const rawSections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    const start = v4aSectionStart(l);
    if (start !== null) {
      cur = { ...start, headerLine: i + 1, raw: [] };
      rawSections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: l, num: i + 1 });
  }
  const sections: V4ASection[] = [];
  for (const rs of rawSections) {
    while (rs.raw.length > 0 && blank(rs.raw[rs.raw.length - 1]!.text)) rs.raw.pop();
    if (rs.kind === 'add') {
      const addLines: string[] = [];
      for (const r of rs.raw) {
        if (r.text === '') addLines.push('');
        else if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind: 'add', path: rs.path, headerLine: rs.headerLine, addLines, chunks: [] });
      continue;
    }
    if (rs.kind === 'delete') {
      if (rs.raw.length > 0) throw new Exit2(`error: parse ${rs.raw[0]!.num}`);
      sections.push({ kind: 'delete', path: rs.path, headerLine: rs.headerLine, addLines: [], chunks: [] });
      continue;
    }
    let idx = 0;
    let moveTo: string | undefined;
    if (rs.raw.length > 0 && (rs.raw[0]!.text === '*** Move to:' || rs.raw[0]!.text.startsWith('*** Move to: '))) {
      moveTo = rs.raw[0]!.text.slice('*** Move to:'.length).trim();
      idx = 1;
    }
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    for (; idx < rs.raw.length; idx += 1) {
      const r = rs.raw[idx]!;
      const l = r.text;
      if (l.startsWith('@@')) {
        chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
        chunks.push(chunk);
        continue;
      }
      if (l === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
        chunk.eof = true;
        chunk = null;
        continue;
      }
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
        if (chunk === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
          chunk = { anchor: null, eof: false, body: [] };
          chunks.push(chunk);
        }
        chunk.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.num}`);
    }
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${rs.headerLine}`);
    sections.push({ kind: 'update', path: rs.path, headerLine: rs.headerLine, moveTo, addLines: [], chunks });
  }
  return sections;
}

/** One V4A section is one edit (SPEC.md section 8). */
function v4aEdit(s: V4ASection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const p = s.path;
    const content = s.addLines.length === 0 ? '' : `${s.addLines.join('\n')}\n`;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, content);
    };
  }
  if (s.kind === 'delete') {
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  const p = s.path;
  const moveTo = s.moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyV4AChunks(before, s.chunks, strict, p);
    if (moveTo !== undefined) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => v4aEdit(s, strict));
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moved = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) moved.set(newP, oldP);
  }
  const movedOld = new Set(moved.values());
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || moved.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of moved) entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
