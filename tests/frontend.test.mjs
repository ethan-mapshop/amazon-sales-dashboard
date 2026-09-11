// Catches the class of bug that reached production once already: a function
// calling a name that nothing defines. `hasBid is not defined` only surfaced
// when a user clicked Update, because the browser resolves names at call time
// and all fourteen scripts share one global scope.
//
// This is a STATIC check, not an execution. It strips comments and string
// literals properly, collects every declared name across all the scripts plus
// the standard built-ins, then reports any identifier that is read but never
// declared anywhere.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// Load order from index.html, so each file is checked against everything that
// exists rather than only against itself.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = [...html.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);

// The ad pages this suite is scoped to. Everything else is inventory.
const AD_PAGES = ['js/ad-redflags.js', 'js/ad-biweekly.js', 'js/ad-monthly.js',
                  'js/ad-campaigns.js'];

console.log('\nSCRIPT INVENTORY');
ok(files.length >= 14, `index.html loads ${files.length} local scripts, one shared scope`);
ok(AD_PAGES.every(f => files.includes(f)), 'including every ad cadence page');

// ─── STRIPPING ───────────────────────────────────────────────────────────────
// Blanks out comments, strings and regex literals so an identifier scan cannot
// read prose. Template literals keep their ${...} contents, which is real code.
// Newlines are preserved throughout so reported line numbers stay true.
function strip(src) {
  const out = [];
  const blank = (t) => t.replace(/[^\n]/g, ' ');

  // One loop, one stack. A template pushes a frame; a ${ inside it pushes a
  // CODE frame, so a comment or a nested template inside an interpolation is
  // handled by exactly the same rules as anywhere else. Getting this wrong is
  // how the first attempt swallowed half of catalog.js.
  const frames = [{ kind: 'code', depth: 0 }];
  const top = () => frames[frames.length - 1];

  // Whether a `/` starts a regex or is division, decided by the last meaningful
  // token: `return /x/` is a regex, `count / 2` is division, and both end in a
  // word character.
  let prev = '';
  const REGEX_OK_AFTER = new Set([
    'return', 'typeof', 'instanceof', 'case', 'in', 'of', 'delete', 'void', 'do',
    'else', 'yield', 'await', 'new', 'throw', 'if', 'while', 'split', 'replace',
    'replaceAll', 'match', 'test', 'search', 'matchAll'
  ]);
  const regexCanStart = () => {
    if (!prev) return true;
    if (/[\w$)\]"]/.test(prev)) {
      const tail = out.slice(-40).join('').match(/([A-Za-z_$][\w$]*)\s*$/);
      return !!(tail && REGEX_OK_AFTER.has(tail[1]));
    }
    return true;
  };

  let i = 0;
  while (i < src.length) {
    const f = top();
    const c = src[i];

    if (f.kind === 'template') {
      if (c === '\\') { out.push('  '); i += 2; continue; }
      if (c === '`') { out.push(' '); frames.pop(); prev = '"'; i++; continue; }
      if (src.slice(i, i + 2) === '${') {
        out.push('  ');
        frames.push({ kind: 'code', depth: 0 });
        prev = '';
        i += 2;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '//') {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? src.length : nl;
      out.push(blank(src.slice(i, stop)));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const e = src.indexOf('*/', i + 2);
      const stop = e === -1 ? src.length : e + 2;
      out.push(blank(src.slice(i, stop)));
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      out.push(blank(src.slice(i, Math.min(j + 1, src.length))));
      prev = '"';
      i = j + 1;
      continue;
    }
    if (c === '`') {
      out.push(' ');
      frames.push({ kind: 'template' });
      i++;
      continue;
    }
    if (c === '{') { f.depth++; out.push(c); prev = c; i++; continue; }
    if (c === '}') {
      // The } that closes a ${ rather than a block.
      if (f.depth === 0 && frames.length > 1) { out.push(' '); frames.pop(); prev = '"'; i++; continue; }
      f.depth--;
      out.push(c);
      prev = c;
      i++;
      continue;
    }
    if (c === '/' && regexCanStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j++;
      }
      if (src[j] === '/') {
        let k = j + 1;
        while (k < src.length && /[gimsuyd]/.test(src[k])) k++;
        out.push(blank(src.slice(i, k)));
        prev = '"';
        i = k;
        continue;
      }
    }
    out.push(c);
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// ─── DECLARED NAMES ──────────────────────────────────────────────────────────
// Everything the page can legitimately reach without declaring it: the standard
// built-ins Node and the browser share, plus the browser-only and CDN globals.
const declared = new Set(Object.getOwnPropertyNames(globalThis));
for (const n of [
  'window', 'document', 'localStorage', 'sessionStorage', 'location', 'navigator',
  'history', 'alert', 'confirm', 'prompt', 'requestAnimationFrame', 'cancelAnimationFrame',
  'FormData', 'FileReader', 'Blob', 'File', 'Image', 'Option', 'Node', 'Element',
  'HTMLElement', 'Worker', 'getComputedStyle', 'matchMedia', 'scrollTo', 'open', 'close',
  'XMLHttpRequest', 'IntersectionObserver', 'MutationObserver', 'ResizeObserver',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'DOMParser', 'Notification',
  'CSS', 'Headers', 'Request', 'Response', 'Audio', 'Range', 'Selection',
  'arguments', 'undefined', 'NaN', 'Infinity',
  // CDN scripts, loaded ahead of ours in index.html
  'XLSX', 'Chart', 'google'
]) declared.add(n);

const sources = new Map();
const stripped = new Map();
for (const rel of files) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  sources.set(rel, src);
  stripped.set(rel, strip(src));
}

// Generous on purpose: a declaration form missed here becomes a false positive,
// which is loud and quickly fixed, while over-collecting only weakens the check.
const DECL = [
  /\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s*\{([^}]*)\}/g,
  /\b(?:const|let|var)\s*\[([^\]]*)\]/g,
  /\bfunction\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g,
  /\bfunction\s*\(([^)]*)\)/g,
  /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
  /\(([^()]*)\)\s*=>/g,
  /\b([A-Za-z_$][\w$]*)\s*=>/g,
  /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
  // Every declarator after the first: let a, b, c;
  /,\s*([A-Za-z_$][\w$]*)\s*(?:=|,|;|\))/g
];

for (const body of stripped.values()) {
  for (const re of DECL) {
    for (const m of body.matchAll(re)) {
      for (const piece of m.slice(1).filter(Boolean).join(',').split(',')) {
        const name = piece.replace(/\.\.\./g, '').split('=')[0].split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
    }
  }
}

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'function', 'class', 'const', 'let', 'var', 'new', 'delete', 'typeof',
  'instanceof', 'in', 'of', 'this', 'super', 'extends', 'try', 'catch', 'finally',
  'throw', 'async', 'await', 'yield', 'true', 'false', 'null', 'void', 'static',
  'get', 'set', 'import', 'export', 'from', 'as', 'with', 'debugger'
]);

console.log('\nUNDECLARED IDENTIFIERS  — resolved at call time, so never at deploy time');

const byFile = new Map();
for (const [rel, body] of stripped) {
  const hits = [];
  for (const m of body.matchAll(/([.?]\s*)?\b([A-Za-z_$][\w$]*)\b(\s*:)?/g)) {
    const [, member, name, asKey] = m;
    if (member || asKey) continue;            // property access, or an object key
    if (KEYWORDS.has(name) || declared.has(name)) continue;
    hits.push(`${rel}:${body.slice(0, m.index).split('\n').length}  ${name}`);
  }
  if (hits.length) byFile.set(rel, [...new Set(hits)]);
}

for (const rel of AD_PAGES) {
  const hits = byFile.get(rel) || [];
  ok(hits.length === 0, `${rel} calls nothing undefined`,
     hits.length ? '\n      ' + hits.slice(0, 20).join('\n      ') : '');
}

const elsewhere = [...byFile].filter(([rel]) => !AD_PAGES.includes(rel));
if (elsewhere.length) {
  console.log('  note  outside the ad pages: ' +
              elsewhere.map(([rel, h]) => `${rel} (${h.length})`).join(', '));
}

console.log('\nCROSS-FILE CALLS  — the ad pages lean on helpers defined elsewhere');
for (const name of ['escapeHtml', 'formatNumber', '_svTimeAgo', 'accessToken', 'productBrandShort']) {
  ok(declared.has(name), `${name} is defined`);
}

console.log('\nNO RESULT CACHE  — decisions are re-made server-side on every read');

const rf = stripped.get('js/ad-redflags.js') || '';
const bw = stripped.get('js/ad-biweekly.js') || '';
const rfRaw = sources.get('js/ad-redflags.js') || '';
const bwRaw = sources.get('js/ad-biweekly.js') || '';

ok(!/arfCacheSave|arfCacheLoad|ARF_RESULT_KEY/.test(rf),
   'the weekly page has no result cache left',
   'four separate stale-data confusions came from storing decisions');
ok(/action=weekly-get/.test(rfRaw), 'and reads its result from the server');
ok(/arfRunSave|arfRunLoad/.test(rf),
   'while in-flight report IDs still survive a reload',
   'a manual run takes minutes and must not be lost to a refresh');

// The bi-weekly reads a legacy key once to rescue a pre-KV run, but writes none.
const bwWrites = [...bwRaw.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)].map(m => m[1]);
ok(!bwWrites.some(k => /result|lastrun/i.test(k)),
   'the bi-weekly page writes no result to storage',
   bwWrites.length ? 'it writes only: ' + bwWrites.join(', ') : 'it writes nothing');
ok(/action=biweekly-get/.test(bwRaw), 'and reads its result from the server');
ok(/action=biweekly-import/.test(bwRaw), 'with an import path for an off-cycle run');
ok(/data\.newer/.test(bwRaw), 'and a banner driven by what the server says is newer');

console.log('\nNO POPUPS  — inline UI only');
for (const rel of AD_PAGES) {
  const hit = /(^|[^.\w])(alert|confirm|prompt)\s*\(/.exec(stripped.get(rel) || '');
  ok(!hit, `${rel} uses inline UI`, hit ? `found ${hit[2]}(` : '');
}
const legacyPopups = files.filter(f => !AD_PAGES.includes(f))
  .filter(f => /(^|[^.\w])(alert|confirm|prompt)\s*\(/.test(stripped.get(f) || ''));
if (legacyPopups.length) {
  console.log('  note  pre-existing popups, outside this suite: ' + legacyPopups.join(', '));
}

console.log(fails === 0 ? '\nfrontend: all assertions pass\n' : `\nfrontend: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
