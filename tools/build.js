#!/usr/bin/env node
/**
 * Concatenates src/header.js + the ES modules into one installable userscript.
 * Imports are dropped and `export` keywords stripped, so modules share one
 * IIFE scope; top-level names must therefore be unique across modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
export const OUTPUT = path.join(srcDir, 'meet-caption-capture.user.js');

// Dependency order; main.js is the entry point and must stay last.
// Add 'dictionary.js' here when that phase lands.
export const MODULES = ['store.js', 'watcher.js', 'writer.js', 'lifecycle.js', 'mascot.js', 'ui.js', 'main.js'];

const IMPORT_RE = /^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*\r?\n/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+function|function|const|let|class)\b)/gm;
const TOP_LEVEL_RE = /^(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

export function transformModule(name, source) {
  const out = source.replace(IMPORT_RE, '').replace(EXPORT_DECL_RE, '');
  const leftover = out.match(/^(?:import|export)\b.*$/m);
  if (leftover) {
    throw new Error(`${name}: unsupported module syntax left after transform: "${leftover[0]}"`);
  }
  return out.trim();
}

export function build() {
  const header = fs.readFileSync(path.join(srcDir, 'header.js'), 'utf8').trim();
  if (!header.startsWith('// ==UserScript==') || !header.endsWith('// ==/UserScript==')) {
    throw new Error('header.js must be exactly the Tampermonkey metadata block');
  }

  const seen = new Map();
  const parts = MODULES.map((name) => {
    const body = transformModule(name, fs.readFileSync(path.join(srcDir, name), 'utf8'));
    for (const m of body.matchAll(TOP_LEVEL_RE)) {
      const id = m[1];
      if (seen.has(id)) {
        throw new Error(`Duplicate top-level name "${id}" in ${name} and ${seen.get(id)}`);
      }
      seen.set(id, name);
    }
    return `// ---- ${name} ----\n${body}`;
  });

  return `${header}\n\n(function () {\n'use strict';\n\n${parts.join('\n\n')}\n})();\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = build();
  fs.writeFileSync(OUTPUT, output);
  console.log(`Wrote ${path.relative(root, OUTPUT)} (${output.length} bytes)`);
}
