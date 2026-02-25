const fs = require('node:fs');
const vm = require('node:vm');

function extractNamedFunctionSource(source, name) {
  const re = new RegExp(String.raw`(^|\n)([ \t]*)(async\s+)?function\s+${name}\s*\(`, 'm');
  const m = re.exec(source);
  if (!m) throw new Error(`Function not found: ${name}`);

  const start = m.index + (m[1] ? m[1].length : 0);
  let i = source.indexOf('{', start);
  if (i < 0) throw new Error(`Function body start not found: ${name}`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && ch === "'") inSingle = false;
      escaped = !escaped && ch === '\\';
      continue;
    }
    if (inDouble) {
      if (!escaped && ch === '"') inDouble = false;
      escaped = !escaped && ch === '\\';
      continue;
    }
    if (inTemplate) {
      if (!escaped && ch === '`') inTemplate = false;
      escaped = !escaped && ch === '\\';
      continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingle = true; escaped = false; continue; }
    if (ch === '"') { inDouble = true; escaped = false; continue; }
    if (ch === '`') { inTemplate = true; escaped = false; continue; }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error(`Function body end not found: ${name}`);
}

function loadFunctions(filePath, names, context = {}) {
  const source = fs.readFileSync(filePath, 'utf8');
  const snippets = names.map((n) => extractNamedFunctionSource(source, n));
  const sandbox = {
    URL,
    TextEncoder,
    TextDecoder,
    console,
    location: { href: 'https://example.com/app', host: 'example.com', hostname: 'example.com' },
    ...context,
  };
  const ctx = vm.createContext(sandbox);
  const script = new vm.Script(`${snippets.join('\n\n')}\n;globalThis.__exports = { ${names.join(', ')} };`);
  script.runInContext(ctx);
  return ctx.__exports;
}

module.exports = {
  loadFunctions,
  extractNamedFunctionSource,
};
