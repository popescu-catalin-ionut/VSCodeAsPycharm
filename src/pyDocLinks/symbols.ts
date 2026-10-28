// Finds where a Python name is defined in a file's text: def, class, or assignment.
// From rufatpro/plugins jetbrains/py-doc-links (MIT), PySymbolReference.kt, with these differences:
// - nested names ("Class.method") are looked up inside the class body;
// - the least indented definition wins (module-level LIMIT = 10 over a local LIMIT = 1 inside a function);
// - "LIMIT == 3" is a comparison, not an assignment;
// - lines inside strings (e.g. "def run(" in a docstring) are not definitions.
import { pythonTextRegions, regionAround } from './pythonText';

export type SymbolKind = 'func' | 'meth' | 'class' | 'data' | 'attr' | 'any';
type Form = 'def' | 'class' | 'assign' | 'self';

// What to look for, in order, per Sphinx role. :func: falls back to class and variable, as in the plugin.
const SEARCH_ORDER: Record<SymbolKind, Form[]> = {
  func: ['def', 'class', 'assign'],
  meth: ['def', 'assign'],
  class: ['class', 'def', 'assign'],
  data: ['assign', 'class', 'def'],
  attr: ['assign', 'self', 'class', 'def'],
  any: ['def', 'class', 'assign'],
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Group 1 is everything before the name, so the name's column is its length.
function formRegex(form: Form, name: string): RegExp {
  const n = escape(name);
  switch (form) {
    case 'def':
      return new RegExp(String.raw`^(\s*(?:async\s+)?def\s+)${n}\s*[(\[]`);
    case 'class':
      return new RegExp(String.raw`^(\s*class\s+)${n}\s*[(:\[]`);
    case 'assign':
      return new RegExp(String.raw`^(\s*)${n}\s*(?::[^=]+)?=(?!=)`);
    case 'self':
      return new RegExp(String.raw`^(\s*self\.)${n}\s*(?::[^=]+)?=(?!=)`);
  }
}

interface CodeLine {
  offset: number;
  text: string;
  indent: number;
}

/** Lines that start in code (not inside a string), with their indentation. Blank lines are skipped. */
function codeLines(source: string): CodeLine[] {
  const regions = pythonTextRegions(source);
  const lines: CodeLine[] = [];
  let offset = 0;
  for (const text of source.split('\n')) {
    const indent = text.length - text.trimStart().length;
    const first = offset + indent;
    const region = regionAround(regions, first);
    const inString = region?.kind === 'string' && region.start < first; // a line inside a multi-line string
    if (text.trim() && !inString) {
      lines.push({ offset, text: text.replace(/\r$/, ''), indent });
    }
    offset += text.length + 1;
  }
  return lines;
}

/** Offset of `symbol` (["func"] or ["Class", "method"]) in `source`, or -1. */
export function findSymbol(source: string, symbol: string[], kind: SymbolKind): number {
  const lines = codeLines(source);
  let from = 0;
  let to = lines.length;
  let scopeIndent = -1;

  // Walk into containers: "Class" of Class.method (a class, or a def for nested functions).
  for (const container of symbol.slice(0, -1)) {
    const hit = best(lines, from, to, scopeIndent, [formRegex('class', container), formRegex('def', container)]);
    if (!hit) {
      return -1;
    }
    scopeIndent = lines[hit.index].indent;
    from = hit.index + 1;
    to = from;
    while (to < lines.length && lines[to].indent > scopeIndent) {
      to++;
    }
  }

  const name = symbol[symbol.length - 1];
  for (const form of SEARCH_ORDER[kind]) {
    const hit = best(lines, from, to, scopeIndent, [formRegex(form, name)]);
    if (hit) {
      return lines[hit.index].offset + hit.column;
    }
  }
  return -1;
}

/** The least indented matching line in lines[from, to) deeper than scopeIndent; the first one on a tie. */
function best(lines: CodeLine[], from: number, to: number, scopeIndent: number, regexes: RegExp[]) {
  let found: { index: number; column: number } | undefined;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (line.indent <= scopeIndent || (found && line.indent >= lines[found.index].indent)) {
      continue;
    }
    for (const re of regexes) {
      const m = re.exec(line.text);
      if (m) {
        found = { index: i, column: m[1].length };
        break;
      }
    }
  }
  return found;
}
