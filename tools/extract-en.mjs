// Dump English dictionaries from the INSTALLED DSH build (upgrade helper).
// Run: node tools/extract-en.mjs
// Output: tools/en.<version>.json  (namespace -> {key: en text})
// Use with diff-keys.mjs after a DSH upgrade to find new untranslated keys.
//
// Method: regex over the LAST `const en = {…}` block per client bundle
// (string-literal values only — both "quoted" and bare keys). Dicts that
// build values from in-file constants (spreads/identifiers) contribute only
// their literal entries; product-name maps shared verbatim across languages
// are intentionally left out (ko ships them unchanged).
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --root <dir>: read the bundles from an npm install prefix instead of the
// locally installed app.asar. Use it to build a baseline for a harness version
// that is not installed yet:
//   npm install --prefix <dir> @deepseek-ai/dsh@<version>
//   node tools/extract-en.mjs --root <dir>
const rootArg = process.argv.indexOf('--root');
const rootDir = rootArg >= 0 ? process.argv[rootArg + 1] : null;

function asarRoot() {
  // Installed location of the running DSH build (Windows first, then macOS).
  const candidates = [
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
  ];
  const base = candidates.find((p) => p && existsSync(p));
  if (!base) throw new Error(`app.asar not found (tried: ${candidates.join(', ')})`);
  const tmp = join(process.env.TEMP ?? '.', 'dsh-asar');
  if (!existsSync(join(tmp, 'dsh'))) {
    console.log('extracting app.asar (one-time, ~1min)…');
    execSync(`asar extract "${base}" "${tmp}"`, { stdio: 'inherit' });
  }
  return tmp;
}

// Either layout: an npm prefix, or the extracted app.asar.
function resolveTarget() {
  if (rootDir) {
    const pkgs = join(rootDir, 'node_modules', '@deepseek-ai');
    if (!existsSync(pkgs)) throw new Error(`no @deepseek-ai packages under ${rootDir}`);
    // The harness itself is at <root> when <root> is the installed package
    // (homebrew prefix), and under node_modules when <root> is an install
    // prefix (npm writes its own package.json into the prefix, so pick the
    // manifest that actually belongs to @deepseek-ai/dsh).
    const candidates = [join(rootDir, 'package.json'), join(pkgs, 'dsh', 'package.json')];
    const manifest = candidates.find((p) => {
      try { return JSON.parse(readFileSync(p, 'utf8')).name === '@deepseek-ai/dsh'; } catch { return false; }
    });
    if (!manifest) throw new Error(`no dsh package.json (tried: ${candidates.join(', ')})`);
    return { pkgs, manifest };
  }
  const tmp = asarRoot();
  return { pkgs: join(tmp, 'dsh', 'node_modules', '@deepseek-ai'), manifest: join(tmp, 'dsh', 'package.json') };
}

function blockAfter(src, marker) {
  const start = src.lastIndexOf(marker);
  if (start < 0) return null;
  const i = src.indexOf('{', start);
  let depth = 0, end = -1, inS = null, esc = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (inS) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === inS) inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  return end < 0 ? null : src.slice(i, end + 1);
}

const PAIR = /(?:\"((?:[^\"\\\n]|\\.)*)\"|([A-Za-z_$][\w$]*))\s*:\s*\"((?:[^\"\\\n]|\\.)*)\"/g;

function stringPairs(block) {
  const out = {};
  let m;
  PAIR.lastIndex = 0;
  while ((m = PAIR.exec(block)) !== null) {
    const k = m[1] !== undefined ? m[1] : m[2];
    if (k.trim() === '') continue;
    try {
      out[k] = JSON.parse('"' + m[3] + '"');
    } catch { /* keep going */ }
  }
  return out;
}

const { pkgs, manifest } = resolveTarget();
const result = {};
let files = 0;

// 1) canonical `const NS = "…" + const en = {…}` plugins
for (const name of readdirSync(pkgs)) {
  const client = join(pkgs, name, 'lib', 'client.js');
  if (!existsSync(client)) continue;
  const src = readFileSync(client, 'utf8');
  const nsMatch = /const NS = "([^"]+)"/.exec(src);
  if (!nsMatch) continue;
  const block = blockAfter(src, 'const en = {');
  if (!block) continue;
  const pairs = stringPairs(block);
  if (Object.keys(pairs).length) {
    result[nsMatch[1]] = pairs;
    files++;
  }
}

// 2) plugins with `const namespace = "…"` (terminal/browser seats)
for (const [file, ns] of [
  ['dsh-client-ui-sidebar-terminal', 'sidebarTerminal'],
  ['dsh-client-ui-sidebar-browser', 'sidebarBrowser'],
]) {
  const client = join(pkgs, file, 'lib', 'client.js');
  if (!existsSync(client)) continue;
  const block = blockAfter(readFileSync(client, 'utf8'), 'const en = {');
  if (!block) continue;
  const pairs = stringPairs(block);
  if (Object.keys(pairs).length) {
    result[ns] = pairs;
    files++;
  }
}

// 3) literal-namespace registrations and non-NS const dicts
for (const [file, marker, ns] of [
  ['dsh-client-ui-settings-account', 'const en = {', 'settings.account'],
  ['dsh-client-ui-agent-preset', 'const en = {', 'settings.agentPreset'],
  ['dsh-client-ui-theme', 'const en = {', 'settings.theme'],
  ['dsh-client-ui-settings-session-log', 'const en = {', 'settings.sessionLog'],
  ['dsh-client-ui-permission-presets', 'const accessEn = {', 'permission.access'],
  ['dsh-client-ui-permission-presets', 'const en = {', 'settings.permission'],
  ['dsh-client-ui-shortcuts', 'const en = {', 'shortcuts'],
  ['dsh-client-ui-layout', 'const en = {', 'shortcuts.layout'],
  ['dsh-client-locale', 'const en$1 = {', 'common'],
]) {
  const client = join(pkgs, file, 'lib', 'client.js');
  if (!existsSync(client)) continue;
  const block = blockAfter(readFileSync(client, 'utf8'), marker);
  if (!block) continue;
  const pairs = stringPairs(block);
  if (Object.keys(pairs).length) {
    result[ns] = pairs;
    files++;
  }
}

// 4) settings.agentPreset: en spreads guideEn (markdown guides built with
// .join), so regex misses them — evaluate the two consts together instead.
{
  const client = join(pkgs, 'dsh-client-ui-agent-preset', 'lib', 'client.js');
  if (existsSync(client)) {
    const src = readFileSync(client, 'utf8');
    const guide = blockAfter(src, 'const guideEn = {');
    const enBlock = blockAfter(src, 'const en = {');
    if (guide && enBlock) {
      try {
        const obj = new Function(`${'const guideEn = ' + guide};\nreturn (${enBlock});`)();
        const flat = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'string'));
        if (Object.keys(flat).length) {
          result['settings.agentPreset'] = flat;
          files++;
        }
      } catch { /* keep going */ }
    }
  }
}

// 5) register-driven dictionaries. Rules 1 to 4 read ONE `const en` per bundle,
// but a bundle that registers several namespaces uses suffixed dicts (`en$1 …
// en$6`) or shorthand (`{ zh, en }`), so the block above lands on the wrong
// object (or on nothing). Resolve every ctx.locale.register call to the
// identifier it passes, and evaluate the file's object literals as one scope so
// literals that spread a sibling dict (`...frequencyEn`) still resolve.
// More accurate than rules 1 to 4, so it overwrites what they produced.
function objectScope(src) {
  const decls = [];
  const re = /const ([A-Za-z_$][\w$]*) = \{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const block = blockAfter(src, m[0]);
    if (block) decls.push([m[1], block]);
  }
  const scope = new Map();
  for (let pass = 0; pass < 3; pass++) {
    let progress = false;
    for (const [name, block] of decls) {
      if (scope.has(name)) continue;
      try {
        const preamble = [...scope].map(([n, v]) => `const ${n} = ${JSON.stringify(v)};`).join('\n');
        const value = new Function(`${preamble} return (${block});`)();
        if (value && typeof value === 'object') { scope.set(name, value); progress = true; }
      } catch { /* a dict this one spreads is not evaluated yet */ }
    }
    if (!progress) break;
  }
  return scope;
}
{
  const re = /ctx\.locale\.register\(\s*([^,]+?)\s*,\s*\{\s*([^}]*)\}/g;
  for (const name of readdirSync(pkgs)) {
    const client = join(pkgs, name, 'lib', 'client.js');
    if (!existsSync(client)) continue;
    const src = readFileSync(client, 'utf8');
    const scope = objectScope(src);
    if (!scope.size) continue;
    let m;
    while ((m = re.exec(src)) !== null) {
      const nsTok = m[1].trim();
      let ns = null;
      if (/^["']/.test(nsTok)) ns = nsTok.slice(1, -1);
      else {
        const decl = new RegExp(`const ${nsTok.replace(/[$]/g, '\\$')} = ["']([^"']+)["']`).exec(src);
        if (decl) ns = decl[1];
      }
      if (!ns) continue;
      const enEntry = /(?:^|,)\s*en\s*(?::\s*([\w$]+))?\s*(?:,|$)/.exec(m[2]);
      const dict = scope.get(enEntry?.[1] ?? 'en');
      if (!dict) continue;
      const flat = Object.fromEntries(Object.entries(dict).filter(([, v]) => typeof v === 'string'));
      if (!Object.keys(flat).length) continue;
      result[ns] = { ...(result[ns] ?? {}), ...flat };
      files++;
    }
  }
}

const version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? 'unknown';
const out = join(root, 'tools', `en.${version}.json`);
writeFileSync(out, JSON.stringify(result, null, 2), 'utf8');
const keys = Object.values(result).reduce((n, o) => n + Object.keys(o).length, 0);
console.log(`DSH ${version}: ${files} files, ${Object.keys(result).length} namespaces, ${keys} keys -> ${out}`);
