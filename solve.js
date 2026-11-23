// A faster drop-in for makefun-site 1.0.0.
//
// run(input) takes one generated site { site, templates, files } and returns
// the output tree { path: text } that makefun-site 1.0.0's build returns for
// it, byte for byte: every page's index.html, the index and tag pages,
// build-report.txt and each static file.
//
// The build follows the reference's own stated order: sources are sorted,
// templates parsed, front matter checked, permalinks assigned, bodies
// rendered to HTML, collections and tags built, layouts rendered, statics
// copied, and the report written last.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ------------------------------------------------------------------ text

const ESCAPES = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

// The slug of a text: NFKD, combining marks dropped, A-Z lowered, each run
// of characters other than a-z and 0-9 one '-', none at either end, cut to
// 64 characters with a '-' left at the cut dropped, 'untitled' when empty.
function slugOf(text) {
  // Pure ASCII needs no normalisation: NFKD is the identity on ASCII and
  // ASCII holds no combining marks, so skip both passes for it.
  const decomposed = /[^\x00-\x7F]/.test(text)
    ? text.normalize('NFKD').replace(/\p{M}/gu, '')
    : text;
  const parts = [];
  let dashed = true;
  for (let i = 0; i < decomposed.length; i++) {
    let c = decomposed.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      parts.push(String.fromCharCode(c));
      dashed = false;
    } else if (!dashed) {
      parts.push('-');
      dashed = true;
    }
  }
  let out = parts.join('');
  if (dashed && out.length > 0) out = out.slice(0, -1);
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

// '2026-11-09' -> '9 November 2026', from the string alone.
function dateLong(d) {
  return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDate(d) {
  if (d.length !== 10) return false;
  if (d.charCodeAt(4) !== 45 || d.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = d.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  if (m < 1 || m > 12 || day < 1) return false;
  const dim = m === 2 && isLeap(y) ? 29 : DIM[m - 1];
  if (day > dim) return false;
  return d >= '1970-01-01' && d <= '2099-12-31';
}

// ------------------------------------------------------------------ front matter

const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);

// Read a quoted string value starting at value[0] === '"'. The closing
// quote must be the value's last character; a quote inside it is a stray
// quote, and a backslash inside it must escape " or \. Returns
// { value } or { reason }.
function readQuoted(value) {
  if (value.length < 2 || value[value.length - 1] !== '"') {
    return { reason: 'a quoted string is not closed' };
  }
  let out = '';
  for (let p = 1; p < value.length - 1; p++) {
    const ch = value[p];
    if (ch === '\\') {
      if (p + 1 > value.length - 2 || (value[p + 1] !== '"' && value[p + 1] !== '\\')) {
        return { reason: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += value[p + 1];
      p++;
    } else if (ch === '"') {
      return { reason: 'a quoted string holds a stray quote' };
    } else {
      out += ch;
    }
  }
  return { value: out };
}

// Validate one front-matter value by its key. Returns the parsed value, or
// sets fault.reason and returns undefined.
function valueOf(key, value, fault) {
  if (key === 'title' || key === 'summary') {
    if (value[0] === '"') {
      const q = readQuoted(value);
      if (q.reason) {
        fault.reason = 'key "' + key + '": ' + q.reason;
        return undefined;
      }
      return q.value;
    }
    if (value[0] === '[') {
      fault.reason = 'key "' + key + '": a bare string opens on [';
      return undefined;
    }
    return value;
  }
  if (key === 'date') {
    if (!validDate(value)) {
      fault.reason = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
      return undefined;
    }
    return value;
  }
  if (key === 'tags') {
    if (value[0] !== '[' || value[value.length - 1] !== ']') {
      fault.reason = 'key "tags": not a list [a, b]';
      return undefined;
    }
    const inner = value.slice(1, -1);
    if (inner.trim() === '') return [];
    const items = inner.split(',');
    for (let i = 0; i < items.length; i++) {
      items[i] = items[i].trim();
      const t = items[i];
      if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) {
        fault.reason = 'key "tags": an empty tag, or one holding " [ or ]';
        return undefined;
      }
    }
    return items;
  }
  if (key === 'draft') {
    if (value !== 'true' && value !== 'false') {
      fault.reason = 'key "draft": true or false';
      return undefined;
    }
    return value === 'true';
  }
  if (key === 'slug') {
    if (!isSlug(value)) {
      fault.reason = 'key "slug": not a slug';
      return undefined;
    }
    return value;
  }
  // layout: kept as written; the template lookup decides it later.
  return value;
}

// A slug value: lowercase letters, digits and single '-' between runs,
// no '-' at either end, at most 64 characters.
function isSlug(v) {
  if (v.length === 0 || v.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
      continue;
    }
    if (c === 45 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

// ------------------------------------------------------------------ templates

// Instruction opcodes for a compiled template.
const T_TEXT = 0;
const T_OUT = 1; // [op, names, raw]
const T_IF = 2; // [op, names, neg, jumpWhenFalse]
const T_ELSE = 3; // [op, jumpPastEndif]
const T_ENDIF = 4;
const T_FOR = 5; // [op, varName, names, endforIdx]
const T_ENDFOR = 6; // [op, forIdx]
const T_INCLUDE = 7; // [op, name]

// Read a dotted path starting at i. Returns { names, end } or null.
function readPath(src, i) {
  const names = [];
  let p = i;
  const n = src.length;
  while (true) {
    const c = src.charCodeAt(p);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return null;
    let q = p + 1;
    while (q < n) {
      const d = src.charCodeAt(q);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) q++;
      else break;
    }
    names.push(src.slice(p, q));
    p = q;
    if (src[p] === '.') {
      p++;
      continue;
    }
    return { names, end: p };
  }
}

function skipSpaces(src, i) {
  while (src[i] === ' ' || src[i] === '\t') i++;
  return i;
}

function readWord(src, i) {
  let q = i;
  while (q < src.length) {
    const c = src.charCodeAt(q);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) q++;
    else break;
  }
  return q === i ? null : src.slice(i, q);
}

// Compile one template source into a flat instruction list. Returns
// { code } or { reason } when the template does not parse.
function compileTemplate(src) {
  // Tokenize: { k, ... } where k is 'text' | 'out' | 'raw' | 'tag'.
  const toks = [];
  let i = 0;
  const n = src.length;
  let textStart = 0;
  while (i < n) {
    if (src[i] === '{' && src[i + 1] === '{') {
      if (textStart < i) toks.push({ k: 'text', s: src.slice(textStart, i) });
      const raw = src[i + 2] === '{';
      let j = skipSpaces(src, i + (raw ? 3 : 2));
      const p = readPath(src, j);
      if (!p) return { reason: 'bad path' };
      j = skipSpaces(src, p.end);
      const close = raw ? '}}}' : '}}';
      if (src.slice(j, j + close.length) !== close) {
        return { reason: raw ? 'unclosed {{{' : 'unclosed {{' };
      }
      toks.push({ k: raw ? 'raw' : 'out', path: p.names });
      i = j + close.length;
      textStart = i;
    } else if (src[i] === '{' && src[i + 1] === '%') {
      if (textStart < i) toks.push({ k: 'text', s: src.slice(textStart, i) });
      const tagStart = i;
      let j = skipSpaces(src, i + 2);
      const kw = readWord(src, j);
      if (!kw) return { reason: 'unknown tag' };
      j += kw.length;
      let tok = null;
      if (kw === 'for') {
        j = skipSpaces(src, j);
        const v = readWord(src, j);
        if (!v) return { reason: 'bad for' };
        j += v.length;
        j = skipSpaces(src, j);
        const w = readWord(src, j);
        if (w !== 'in') return { reason: 'bad for' };
        j += 2;
        j = skipSpaces(src, j);
        const p = readPath(src, j);
        if (!p) return { reason: 'bad path' };
        j = p.end;
        tok = { k: 'for', v, path: p.names };
      } else if (kw === 'if') {
        j = skipSpaces(src, j);
        let neg = false;
        const w = readWord(src, j);
        if (w === 'not') {
          neg = true;
          j += 3;
          j = skipSpaces(src, j);
        }
        const p = readPath(src, j);
        if (!p) return { reason: 'bad path' };
        j = p.end;
        tok = { k: 'if', path: p.names, neg };
      } else if (kw === 'else' || kw === 'endif' || kw === 'endfor') {
        tok = { k: kw };
      } else if (kw === 'include') {
        j = skipSpaces(src, j);
        if (src[j] !== '"') return { reason: 'bad include' };
        const end = src.indexOf('"', j + 1);
        if (end === -1) return { reason: 'unclosed {%' };
        tok = { k: 'include', name: src.slice(j + 1, end) };
        j = end + 1;
      } else {
        return { reason: 'unknown tag' };
      }
      j = skipSpaces(src, j);
      if (src.slice(j, j + 2) !== '%}') return { reason: 'unclosed {%' };
      tok.start = tagStart;
      tok.end = j + 2;
      toks.push(tok);
      i = j + 2;
      textStart = i;
    } else {
      i++;
    }
  }
  if (textStart < n) toks.push({ k: 'text', s: src.slice(textStart) });

  // A {% %} tag alone on its line takes the whole line with it, its \n
  // included. Decide from the source text, then trim the neighbours.
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok.k === 'text' || tok.k === 'out' || tok.k === 'raw') continue;
    let a = src.lastIndexOf('\n', tok.start - 1);
    const before = src.slice(a + 1, tok.start);
    if (!/^[ \t]*$/.test(before)) continue;
    let b = src.indexOf('\n', tok.end);
    const after = src.slice(tok.end, b === -1 ? src.length : b);
    if (!/^[ \t]*$/.test(after)) continue;
    // Trim the spaces after the last \n of the preceding text, and the
    // spaces plus the \n of the following text.
    const prev = toks[t - 1];
    if (prev && prev.k === 'text') {
      const li = prev.s.lastIndexOf('\n');
      prev.s = li === -1 ? '' : prev.s.slice(0, li + 1);
    }
    const next = toks[t + 1];
    if (next && next.k === 'text') {
      const fi = next.s.indexOf('\n');
      next.s = fi === -1 ? '' : next.s.slice(fi + 1);
    }
  }

  // Resolve structure: match for/endfor and if/else/endif, and flatten to
  // instructions with jump targets.
  const code = [];
  const stack = [];
  for (let t = 0; t < toks.length; t++) {
    const tok = toks[t];
    if (tok.k === 'text') {
      if (tok.s !== '') code.push([T_TEXT, tok.s]);
    } else if (tok.k === 'out' || tok.k === 'raw') {
      code.push([T_OUT, tok.path, tok.k === 'raw' ? 1 : 0]);
    } else if (tok.k === 'if') {
      stack.push({ kind: 'if', idx: code.length, elseIdx: -1 });
      code.push([T_IF, tok.path, tok.neg ? 1 : 0, -1]);
    } else if (tok.k === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if' || top.elseIdx !== -1) return { reason: 'else without if' };
      top.elseIdx = code.length;
      code.push([T_ELSE, -1]);
    } else if (tok.k === 'endif') {
      const top = stack.pop();
      if (!top || top.kind !== 'if') return { reason: 'endif without if' };
      const ifIns = code[top.idx];
      ifIns[3] = top.elseIdx !== -1 ? top.elseIdx + 1 : code.length + 1;
      if (top.elseIdx !== -1) code[top.elseIdx][1] = code.length + 1;
      code.push([T_ENDIF]);
    } else if (tok.k === 'for') {
      stack.push({ kind: 'for', idx: code.length });
      code.push([T_FOR, tok.v, tok.path, -1]);
    } else if (tok.k === 'endfor') {
      const top = stack.pop();
      if (!top || top.kind !== 'for') return { reason: 'endfor without for' };
      code[top.idx][3] = code.length;
      code.push([T_ENDFOR, top.idx]);
    } else if (tok.k === 'include') {
      code.push([T_INCLUDE, tok.name]);
    }
  }
  if (stack.length !== 0) {
    return { reason: stack[stack.length - 1].kind === 'for' ? 'unclosed for' : 'unclosed if' };
  }
  return { code };
}

// ------------------------------------------------------------------ template values

function truthy(v) {
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0 &&
    !(Array.isArray(v) && v.length === 0);
}

// A path's first name is read from the innermost loop that binds it (loop
// before the element), else from the page's values; each next name is an own
// property of the value so far, or the path is undefined.
function lookupPath(root, frames, names) {
  const first = names[0];
  let v;
  let found = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i].bind;
    if (Object.prototype.hasOwnProperty.call(f, first)) {
      v = f[first];
      found = true;
      break;
    }
  }
  if (!found) {
    if (!Object.prototype.hasOwnProperty.call(root, first)) return undefined;
    v = root[first];
  }
  for (let i = 1; i < names.length; i++) {
    if (v === null || v === undefined || typeof v !== 'object') return undefined;
    const nm = names[i];
    if (!Object.prototype.hasOwnProperty.call(v, nm)) return undefined;
    v = v[nm];
  }
  return v;
}

// Write a value as the template dialect writes it: a string itself, a number
// in JavaScript's own digits, true or false, an array as its items written
// and joined by ', ', anything else as "".
function writeValue(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(', ');
      writeValue(v[i], out);
    }
  }
}

function writeValueEsc(v, out) {
  if (typeof v === 'string') pushEsc(v, out);
  else if (typeof v === 'number') out.push(String(v));
  else if (typeof v === 'boolean') out.push(v ? 'true' : 'false');
  else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(', ');
      writeValueEsc(v[i], out);
    }
  }
}

// Render a compiled template into out (an array of chunks). frames is the
// shared scope stack; depth counts include nesting (a missing template, or
// one nested more than 8 deep, renders nothing).
function renderCompiled(code, compiled, root, out, depth, frames) {
  let ip = 0;
  while (ip < code.length) {
    const ins = code[ip];
    switch (ins[0]) {
      case T_TEXT:
        out.push(ins[1]);
        ip++;
        break;
      case T_OUT: {
        const v = lookupPath(root, frames, ins[1]);
        if (ins[2]) writeValue(v, out);
        else writeValueEsc(v, out);
        ip++;
        break;
      }
      case T_IF: {
        let t = truthy(lookupPath(root, frames, ins[1]));
        if (ins[2]) t = !t;
        ip = t ? ip + 1 : ins[3];
        break;
      }
      case T_ELSE:
        ip = ins[1];
        break;
      case T_ENDIF:
        ip++;
        break;
      case T_FOR: {
        const v = lookupPath(root, frames, ins[2]);
        if (!Array.isArray(v) || v.length === 0) {
          ip = ins[3] + 1;
          break;
        }
        const loop = { index: 1, first: true, last: v.length === 1, length: v.length };
        const frame = {};
        frame[ins[1]] = v[0];
        frame.loop = loop;
        frames.push({ bind: frame, arr: v, idx: 0, start: ip + 1, end: ins[3], loop, vname: ins[1] });
        ip++;
        break;
      }
      case T_ENDFOR: {
        const fr = frames[frames.length - 1];
        fr.idx++;
        if (fr.idx < fr.arr.length) {
          fr.loop.index = fr.idx + 1;
          fr.loop.first = false;
          fr.loop.last = fr.idx === fr.arr.length - 1;
          fr.bind[fr.vname] = fr.arr[fr.idx];
          ip = fr.start;
        } else {
          frames.pop();
          ip++;
        }
        break;
      }
      case T_INCLUDE: {
        const sub = compiled[ins[1]];
        if (sub && depth < 8) renderCompiled(sub, compiled, root, out, depth + 1, frames);
        ip++;
        break;
      }
      default:
        ip++;
    }
  }
}

// Render a template by name (when it parsed) into a string. The top
// render is depth 0: an include renders its template one deeper, while
// the depth is under 8, so a template 8 deep still renders and one deeper
// does not.
function renderTemplate(name, compiled, root) {
  const code = compiled[name];
  if (!code) return '';
  const out = [];
  renderCompiled(code, compiled, root, out, 0, []);
  return out.join('');
}

// ------------------------------------------------------------------ markdown

const ESCAPABLE = new Set([
  '\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>',
]);

function isEscapableCode(c) {
  return c === 92 || c === 96 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

// Find the next '**' at or after from, skipping escaped pairs only: the
// next '**' closes the strong, even one a backtick opened a span over.
// Returns the index or -1.
function findStrong(s, from) {
  let j = from;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
    j++;
  }
  return -1;
}

// Find the next single '*' at or after from: one not beside another '*',
// not escaped. The text is read in units: an escape pair and a '**' pair
// are each one unit, so a '*' that follows a '**' pair is a lone '*' and a
// valid closer (its neighbour belongs to the pair, not to it). A backtick
// is an ordinary character here: the next '*' closes the emphasis even
// inside what a backtick opened. Returns the index or -1.
function findEm(s, from) {
  let j = from;
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        j += 2;
        continue;
      }
      return j;
    }
    j++;
  }
  return -1;
}

// Read a link starting at s[i] === '[' far enough to know it is one:
// its text end, its target end and its target. Returns null when s[i]
// opens no link. Pure: it neither resolves the href nor renders the text,
// so the caller can flush the plain run before it first.
function linkParts(s, i) {
  const n = s.length;
  let j = i + 1;
  let textEnd = -1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isEscapableCode(s.charCodeAt(j + 1))) {
      j += 2;
      continue;
    }
    if (c === 93) {
      textEnd = j;
      break;
    }
    j++;
  }
  if (textEnd === -1) return null;
  if (s[textEnd + 1] !== '(') return null;
  const tStart = textEnd + 2;
  const tEnd = s.indexOf(')', tStart);
  if (tEnd === -1) return null;
  const target = s.slice(tStart, tEnd);
  if (target === '' || /\s/.test(target)) return null;
  return { textEnd, tEnd, target };
}

// A link's href: a target with a scheme, opening on '/' or '#', is kept as
// written. Any other is a path from the source's directory, with an optional
// '#' fragment: the url of the page built from that source, or
// <base>/<path> of a static file. A target naming neither is a broken link,
// reported once per (source, target), and kept as written.
// A target with a scheme: a letter, then letters, digits, '+', '-' or '.',
// then ':'.
function isScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 43 || c === 45 || c === 46) continue;
    return false;
  }
  return false;
}

function resolveHref(target, ctx) {
  if (isScheme(target)) return target;
  if (target[0] === '/' || target[0] === '#') return target;
  const hash = target.indexOf('#');
  const pathPart = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const parts = ctx.dir === '' ? [] : ctx.dir.split('/');
  const segs = pathPart.split('/');
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = parts.join('/');
  const page = ctx.pageBySource.get(resolved);
  if (page !== undefined) return page + frag;
  if (ctx.statics.has(resolved)) return ctx.base + '/' + resolved + frag;
  const key = ctx.src + '\n' + target;
  if (!ctx.brokenSeen.has(key)) {
    ctx.brokenSeen.add(key);
    ctx.report.push('broken-link ' + ctx.src + ' -> ' + target);
  }
  return target;
}

// HTML-escape s into out (an array of chunks): the five replacements of
// the reference's table. One regex scan that pushes raw runs and entities
// beats a test plus a replace with a callback per match, and writing into
// the caller's array instead of allocating a joined string keeps the
// caller from paying for a string of its own.
const ESC_RE_G = /[&<>"']/g;
function pushEsc(s, out) {
  ESC_RE_G.lastIndex = 0;
  let m;
  let start = 0;
  while ((m = ESC_RE_G.exec(s)) !== null) {
    if (m.index > start) out.push(s.slice(start, m.index));
    out.push(ESCAPES[m[0]]);
    start = m.index + 1;
  }
  if (start < s.length) out.push(s.slice(start));
}

// The next character that is either an inline special (backslash,
// backtick, '*' or '[') or an HTML-escapable (& < > " '), at or after
// from, or -1. One regex scan handles both: plain runs between matches
// hold neither, so they are pushed raw, and escapables become entities
// on the spot instead of paying an esc() call per run.
const SCAN_RE_G = /[\\`*\[]|[&<>"']/g;
function nextScan(s, from) {
  SCAN_RE_G.lastIndex = from;
  const m = SCAN_RE_G.exec(s);
  return m ? m.index : -1;
}

// Inline Markdown into out (an array of chunks), left to right: escapes,
// code spans, strong, emphasis, links; every other character written
// escaped. Raw HTML is text. The scan jumps from one special or escapable
// to the next, so plain runs are pushed raw and escapables become their
// entities inline; writing into the caller's array instead of joining a
// string of its own keeps every nested span from allocating an array and
// a string.
function inlineInto(s, ctx, out) {
  let i = 0;
  const n = s.length;
  let bufStart = 0;
  while (true) {
    const j = nextScan(s, i);
    if (j === -1) break;
    i = j;
    const c = s.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      // An escapable: flush the plain run raw, then its entity.
      if (i > bufStart) out.push(s.slice(bufStart, i));
      out.push(ESCAPES[s[i]]);
      i++;
      bufStart = i;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n && isEscapableCode(s.charCodeAt(i + 1))) {
        if (i > bufStart) out.push(s.slice(bufStart, i));
        out.push(s[i + 1]);
        i += 2;
        bufStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', i + 1);
      if (k !== -1 && k > i + 1) {
        if (i > bufStart) out.push(s.slice(bufStart, i));
        out.push('<code>');
        pushEsc(s.slice(i + 1, k), out);
        out.push('</code>');
        i = k + 1;
        bufStart = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const k = findStrong(s, i + 2);
        if (k !== -1 && k > i + 2) {
          if (i > bufStart) out.push(s.slice(bufStart, i));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, k), ctx, out);
          out.push('</strong>');
          i = k + 2;
          bufStart = i;
        } else {
          i += 2;
        }
      } else {
        const k = findEm(s, i + 1);
        if (k !== -1 && k > i + 1) {
          if (i > bufStart) out.push(s.slice(bufStart, i));
          out.push('<em>');
          inlineInto(s.slice(i + 1, k), ctx, out);
          out.push('</em>');
          i = k + 1;
          bufStart = i;
        } else {
          i++;
        }
      }
      continue;
    }
    // c === 91, a '[' that may open a link.
    const lp = linkParts(s, i);
    if (lp) {
      const href = resolveHref(lp.target, ctx);
      if (i > bufStart) out.push(s.slice(bufStart, i));
      out.push('<a href="');
      pushEsc(href, out);
      out.push('">');
      inlineInto(s.slice(i + 1, lp.textEnd), ctx, out);
      out.push('</a>');
      i = lp.tEnd + 1;
      bufStart = i;
    } else {
      i++;
    }
  }
  if (n > bufStart) out.push(s.slice(bufStart));
}

// Inline Markdown to a string: the same scan, joined. Only the callers
// that need the string itself (a heading's html, the first paragraph's
// excerpt) use this; the rest write straight into their own array.
function inline(s, ctx) {
  const out = [];
  inlineInto(s, ctx, out);
  return out.join('');
}

function trimLine(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

function isBlank(s) {
  const n = s.length;
  if (n === 0) return true;
  // A line whose first character is not a space or tab cannot be blank,
  // and most content lines start with one, so this one check settles it
  // without scanning the whole line.
  const c0 = s.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A fence opener: ``` plus an optional language, then spaces/tabs only.
// Returns the language, or null when the line is not a fence opener.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return i === line.length ? lang : null;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading: 1-6 '#', at least one space/tab, then text. Returns
// { level, text } or null.
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let level = 0;
  while (level < line.length && line.charCodeAt(level) === 35) level++;
  if (level === 0 || level > 6) return null;
  const c = line.charCodeAt(level);
  if (c !== 32 && c !== 9) return null;
  const text = trimEndSpaces(line.slice(level + 1));
  if (text === '') return null;
  return { level, text };
}

function trimEndSpaces(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

function isBreak(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

// A list item marker. Returns { ordered, num, text } or null.
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if (c0 === 45 || c0 === 42) {
    if (line.charCodeAt(1) === 32) return { ordered: false, num: 0, text: line.slice(2) };
    return null;
  }
  if (c0 < 48 || c0 > 57) return null;
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { ordered: true, num: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

// Render one body to HTML. Takes the source's split lines and the index of
// the first body line (after the closing front-matter fence) instead of a
// joined body string, so the caller never has to join the lines back
// together and split them again. Returns { html, toc, excerpt }.
function renderMarkdown(lines, start, ctx) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const headIds = new Set();
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      out.push('<pre><code');
      if (lang !== '') out.push(' class="language-', lang, '"');
      out.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        pushEsc(lines[i], out);
        out.push('\n');
        i++;
      }
      if (i < n) i++;
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h) {
      let id = slugOf(h.text);
      if (headIds.has(id)) {
        let k = 2;
        while (headIds.has(id + '-' + k)) k++;
        id = id + '-' + k;
      }
      headIds.add(id);
      const html = inline(h.text, ctx);
      if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html });
      out.push('<h', String(h.level), ' id="', id, '">', html, '</h', String(h.level), '>\n');
      i++;
      continue;
    }
    if (isBreak(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const q = [];
      while (i < n && lines[i][0] === '>') {
        let t = lines[i].slice(1);
        if (t[0] === ' ') t = t.slice(1);
        t = trimLine(t);
        if (t !== '') q.push(t);
        i++;
      }
      if (q.length > 0) {
        out.push('<blockquote>\n<p>');
        inlineInto(q.join('\n'), ctx, out);
        out.push('</p>\n</blockquote>\n');
      } else {
        out.push('<blockquote>\n</blockquote>\n');
      }
      continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const ordered = lm.ordered;
      const startNum = lm.num;
      const items = [];
      let cur = lm.text;
      i++;
      while (i < n) {
        const l = lines[i];
        const m2 = listMarker(l);
        if (m2 && m2.ordered === ordered) {
          items.push(cur);
          cur = m2.text;
          i++;
          continue;
        }
        // A line of two or more spaces then a non-space continues the item.
        let sp = 0;
        while (sp < l.length && (l[sp] === ' ' || l[sp] === '\t')) sp++;
        if (sp >= 2 && trimLine(l) !== '') {
          cur += '\n' + trimLine(l);
          i++;
          continue;
        }
        break;
      }
      items.push(cur);
      if (ordered) {
        out.push(startNum !== 1 ? '<ol start="' + startNum + '">\n' : '<ol>\n');
      } else {
        out.push('<ul>\n');
      }
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inlineInto(items[k], ctx, out);
        out.push('</li>\n');
      }
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break. Most lines are plain text, so
    // the first character decides which checks can even apply.
    const plines = [];
    while (i < n) {
      const l = lines[i];
      if (l.length === 0) break;
      const c0 = l.charCodeAt(0);
      if (c0 === 32 || c0 === 9) {
        if (isBlank(l)) break;
      } else if (c0 === 96) {
        if (fenceLang(l) !== null) break;
      } else if (c0 === 35) {
        if (headingOf(l)) break;
      } else if (c0 === 45 || c0 === 42) {
        if (isBreak(l)) break;
      }
      plines.push(trimLine(l));
      i++;
    }
    // The first paragraph's inline text is the excerpt, so it alone
    // needs the string; later paragraphs write straight into out.
    if (excerpt === null) {
      const inner = inline(plines.join('\n'), ctx);
      excerpt = inner;
      out.push('<p>', inner, '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(plines.join('\n'), ctx, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ the build

function dirOf(path) {
  const k = path.lastIndexOf('/');
  return k === -1 ? '' : path.slice(0, k);
}

// Whitespace by the reference's own list, as one table lookup per code
// unit instead of a chain of comparisons.
const WS = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

// Words in the body lines from start on: same count as wordsOf over the
// joined body, because a word never spans the '\n' between two lines.
function wordsOfLines(lines, start) {
  let count = 0;
  for (let k = start; k < lines.length; k++) {
    const s = lines[k];
    let inWord = false;
    for (let i = 0; i < s.length; i++) {
      if (WS[s.charCodeAt(i)]) inWord = false;
      else if (!inWord) {
        inWord = true;
        count++;
      }
    }
  }
  return count;
}

function wordsOf(body) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    if (WS[body.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const perPage = site.per_page;
  const recentN = site.recent;
  const report = [];
  const out = {};

  // 1. Sources, sorted by path in code-unit order.
  const files = input.files.slice();
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push(f);
    else statics.push(f);
  }
  const staticSet = new Set();
  for (const f of statics) staticSet.add(f.path);

  // 2. Templates, parsed in code-unit order of name.
  const names = Object.keys(input.templates).sort();
  const compiled = {};
  for (const name of names) {
    const c = compileTemplate(input.templates[name]);
    if (c.code) compiled[name] = c.code;
    else report.push('template "' + name + '": ' + c.reason);
  }

  // 3. Front matter, in the reference's check order.
  const kept = [];
  for (const f of sources) {
    const path = f.path;
    const content = f.content.indexOf('\r') === -1
      ? f.content
      : f.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = content.split('\n');
    if (lines[0] !== '---') {
      report.push('refused ' + path + ': no front matter');
      continue;
    }
    let close = -1;
    for (let k = 1; k < lines.length; k++) {
      if (lines[k] === '---') {
        close = k;
        break;
      }
    }
    if (close === -1) {
      report.push('refused ' + path + ': the front matter is not closed');
      continue;
    }
    const fm = {};
    const seen = new Set();
    const fault = { reason: null };
    for (let k = 1; k < close && !fault.reason; k++) {
      const line = lines[k];
      const n = k + 1;
      if (isBlank(line)) continue;
      if (line[0] === '#') continue;
      let ci = 0;
      while (ci < line.length) {
        const cc = line.charCodeAt(ci);
        if ((cc >= 97 && cc <= 122) || cc === 95) ci++;
        else break;
      }
      if (ci === 0 || line.charCodeAt(ci) !== 58) {
        fault.reason = 'line ' + n + ' is not "key: value"';
        break;
      }
      const key = line.slice(0, ci);
      const rest = line.slice(ci + 1);
      if (rest !== '' && rest[0] !== ' ') {
        fault.reason = 'line ' + n + ' is not "key: value"';
        break;
      }
      const value = rest === '' ? '' : rest.slice(1).replace(/[ \t]+$/, '');
      if (!KNOWN_KEYS.has(key)) {
        fault.reason = 'unknown key "' + key + '"';
        break;
      }
      if (seen.has(key)) {
        fault.reason = 'key "' + key + '" is given twice';
        break;
      }
      if (value === '') {
        fault.reason = 'key "' + key + '" has no value';
        break;
      }
      const parsed = valueOf(key, value, fault);
      if (fault.reason) break;
      seen.add(key);
      fm[key] = parsed;
    }
    if (fault.reason) {
      report.push('refused ' + path + ': ' + fault.reason);
      continue;
    }
    if (!('title' in fm) || fm.title === '') {
      report.push('refused ' + path + ': no title');
      continue;
    }
    const dir = dirOf(path);
    const isPost = path.startsWith('posts/');
    if (dir === 'tags' || dir.startsWith('tags/') || dir === 'page' || dir.startsWith('page/')) {
      const top = dir.split('/')[0];
      report.push('refused ' + path + ': ' + top + '/ is the generator\'s own');
      continue;
    }
    if (isPost && !('date' in fm)) {
      report.push('refused ' + path + ': a post needs a date');
      continue;
    }
    const layout = fm.layout || (isPost ? 'post' : 'page');
    if (!compiled[layout]) {
      report.push('refused ' + path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) {
      report.push('draft ' + path);
      continue;
    }
    kept.push({
      path,
      dir,
      isPost,
      fm,
      layout,
      lines,
      bodyStart: close + 1,
    });
  }

  // 4. Permalinks: a post's directory is posts/, a page's is its source's
  // directory; the slug is its slug key or the slug of its title, made
  // unique in its directory in source order. At the root, posts, tags and
  // page are taken from the start.
  const takenByDir = new Map();
  for (const s of kept) {
    const outDir = s.isPost ? 'posts' : s.dir;
    let taken = takenByDir.get(outDir);
    if (!taken) {
      taken = new Set();
      if (outDir === '') {
        taken.add('posts');
        taken.add('tags');
        taken.add('page');
      }
      takenByDir.set(outDir, taken);
    }
    const baseSlug = s.fm.slug || slugOf(s.fm.title);
    let slug = baseSlug;
    if (taken.has(slug)) {
      let k = 2;
      while (taken.has(baseSlug + '-' + k)) k++;
      slug = baseSlug + '-' + k;
    }
    taken.add(slug);
    s.slug = slug;
    s.url = outDir === '' ? base + '/' + slug + '/' : base + '/' + outDir + '/' + slug + '/';
    s.outPath = outDir === '' ? slug + '/index.html' : outDir + '/' + slug + '/index.html';
  }

  // 5. Markdown, each source's body rendered to HTML, its links resolved.
  const pageBySource = new Map();
  for (const s of kept) pageBySource.set(s.path, s.url);
  const brokenSeen = new Set();
  const ctx = {
    src: '',
    dir: '',
    pageBySource,
    statics: staticSet,
    base,
    brokenSeen,
    report,
  };
  for (const s of kept) {
    ctx.src = s.path;
    ctx.dir = s.dir;
    const md = renderMarkdown(s.lines, s.bodyStart, ctx);
    s.content = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.readingMinutes = Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart) / 200));
  }

  // 6. Collections: the posts, newest date first, equal dates by slug.
  const posts = kept.filter((s) => s.isPost);
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const pages = kept.filter((s) => !s.isPost);

  // 7. Tags: each post's tags, each slug once (the first spelling kept), in
  // its own order; a tag is all the posts whose tags have its slug, named as
  // first met walking the posts in collection order. Tags are ordered by
  // count, most first, then by slug.
  const tagBySlug = new Map();
  for (const p of posts) {
    const seen = new Set();
    const tags = [];
    const raw = p.fm.tags || [];
    for (const name of raw) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      tags.push({ name, slug });
    }
    p.tagList = tags;
    for (const t of tags) {
      let tag = tagBySlug.get(t.slug);
      if (!tag) {
        tag = { name: t.name, slug: t.slug, url: base + '/tags/' + t.slug + '/', posts: [] };
        tagBySlug.set(t.slug, tag);
      }
      tag.posts.push(p);
    }
  }
  for (const pg of pages) {
    const seen = new Set();
    const tags = [];
    const raw = pg.fm.tags || [];
    for (const name of raw) {
      const slug = slugOf(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      tags.push({ name, slug });
    }
    pg.tagList = tags;
  }
  const tagList = [...tagBySlug.values()];
  tagList.sort((a, b) => {
    if (a.posts.length !== b.posts.length) return b.posts.length - a.posts.length;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  const tagsValue = tagList.map((t) => ({
    name: t.name, slug: t.slug, url: t.url, count: t.posts.length,
  }));

  // Cards and page values.
  function cardOf(s) {
    return {
      title: s.fm.title,
      url: s.url,
      date: s.fm.date || '',
      date_long: s.fm.date ? dateLong(s.fm.date) : '',
      summary: s.fm.summary || '',
      excerpt: s.excerpt,
      reading_minutes: s.readingMinutes,
      tags: s.tagList.map((t) => {
        const tag = tagBySlug.get(t.slug);
        // A tag is the tag of its slug: the name it is first met with
        // walking the posts, and its url; where no post has that slug, the
        // source's own spelling and the url "".
        return tag
          ? { name: tag.name, slug: t.slug, url: tag.url }
          : { name: t.name, slug: t.slug, url: '' };
      }),
    };
  }
  for (const p of posts) p.card = cardOf(p);
  for (const pg of pages) pg.card = cardOf(pg);

  function neighbourOf(p, i) {
    if (!p) return null;
    return { title: p.fm.title, url: p.url, date: p.fm.date || '', date_long: p.fm.date ? dateLong(p.fm.date) : '' };
  }
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.page = Object.assign({}, p.card, {
      slug: p.slug,
      content: p.content,
      toc: p.toc,
      newer: neighbourOf(posts[i - 1], i),
      older: neighbourOf(posts[i + 1], i),
      is_post: true,
    });
  }
  for (const pg of pages) {
    pg.page = Object.assign({}, pg.card, {
      slug: pg.slug,
      content: pg.content,
      toc: pg.toc,
      newer: null,
      older: null,
      is_post: false,
    });
  }

  const siteValue = { title: site.title, base_url: base };
  const recentCards = posts.slice(0, recentN).map((p) => p.card);

  // 8. Layouts.
  const written = new Set();
  for (const s of kept) {
    const root = { site: siteValue, tags: tagsValue, recent: recentCards, page: s.page };
    out[s.outPath] = renderTemplate(s.layout, compiled, root);
    written.add(s.outPath);
  }
  const perPageN = perPage < 1 ? 1 : perPage;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPageN));
  if (compiled.index) {
    for (let p = 1; p <= totalPages; p++) {
      const slice = posts.slice((p - 1) * perPageN, p * perPageN);
      const pager = {
        number: p,
        total: totalPages,
        url: p === 1 ? base + '/' : base + '/page/' + p + '/',
        newer_url: p === 1 ? '' : p === 2 ? base + '/' : base + '/page/' + (p - 1) + '/',
        older_url: p === totalPages ? '' : base + '/page/' + (p + 1) + '/',
      };
      const root = {
        site: siteValue,
        tags: tagsValue,
        recent: recentCards,
        posts: slice.map((x) => x.card),
        pager,
      };
      const path = p === 1 ? 'index.html' : 'page/' + p + '/index.html';
      out[path] = renderTemplate('index', compiled, root);
      written.add(path);
    }
  }
  if (compiled.tag) {
    for (const t of tagList) {
      const root = {
        site: siteValue,
        tags: tagsValue,
        recent: recentCards,
        tag: {
          name: t.name,
          slug: t.slug,
          url: t.url,
          count: t.posts.length,
          posts: t.posts.map((x) => x.card),
        },
      };
      const path = 'tags/' + t.slug + '/index.html';
      out[path] = renderTemplate('tag', compiled, root);
      written.add(path);
    }
  }
  if (compiled.tags) {
    const root = { site: siteValue, tags: tagsValue, recent: recentCards };
    out['tags/index.html'] = renderTemplate('tags', compiled, root);
    written.add('tags/index.html');
  }

  // Each static file at its own path, unless a built page has that path.
  // Every static counts in the total, shadowed or not, and a written
  // static's path is taken, so a second file at the same path is shadowed
  // too and the first one stays.
  let staticWritten = 0;
  for (const f of statics) {
    staticWritten++;
    if (written.has(f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    out[f.path] = f.content;
    written.add(f.path);
  }

  // 9. The report.
  report.sort();
  report.push(
    'built ' + pages.length + ' pages, ' + posts.length + ' posts, ' +
    tagList.length + ' tags and ' + staticWritten + ' static files',
  );
  out['build-report.txt'] = report.map((l) => l + '\n').join('');

  return out;
}
