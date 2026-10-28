// Finds the references Python Doc Links makes clickable in docstrings and comments.
// From rufatpro/plugins jetbrains/py-doc-links (MIT), PatternMatcher.kt; extended with the Sphinx forms it missed.

export type RefKind = 'file' | 'func' | 'meth' | 'class' | 'data' | 'attr' | 'mod' | 'any';

export interface DocRef {
  kind: RefKind;
  /** What to resolve: "a.py", "pkg/a.py", "module.func", "Class.method", ... */
  target: string;
  /** Range of the target within the searched text (end exclusive). */
  start: number;
  end: number;
}

const ROLE_KIND: Record<string, RefKind> = {
  func: 'func', meth: 'meth', class: 'class', exc: 'class', data: 'data', attr: 'attr', mod: 'mod', obj: 'any',
};

// :role:`target` and :py:role:`target`, with Sphinx's "title <target>", "~target" / "!target" and "target()" forms.
const SPHINX_RE = /:(?:py:)?(func|meth|class|exc|data|attr|mod|obj):`(?:[^`<>]*<)?[~!]?(\w+(?:\.\w+)*)(?:\(\))?>?`/g;

// a.py, my-file.py, pkg/a.py, ../a.py, pkg\a.py (the folder part helps pick the right one of several a.py).
const FILE_RE = /(?<!\w)((?:[\w.-]+[/\\])*\w[\w-]*\.py)(?!\w)/g;

/** All references in `text`, by position; where two overlap, the Sphinx one wins (it is found first). */
export function findReferences(text: string): DocRef[] {
  const found: DocRef[] = [];
  for (const m of text.matchAll(SPHINX_RE)) {
    const target = m[2];
    const start = m.index! + m[0].lastIndexOf(target);
    found.push({ kind: ROLE_KIND[m[1]], target, start, end: start + target.length });
  }
  for (const m of text.matchAll(FILE_RE)) {
    const start = m.index! + m[0].indexOf(m[1]);
    found.push({ kind: 'file', target: m[1], start, end: start + m[1].length });
  }
  found.sort((a, b) => a.start - b.start); // stable: Sphinx before file at the same start
  const refs: DocRef[] = [];
  for (const ref of found) {
    const last = refs[refs.length - 1];
    if (!last || ref.start >= last.end) {
      refs.push(ref);
    }
  }
  return refs;
}

export interface SymbolLookup {
  /** Module path to look in ("pkg.module" -> pkg/module.py); empty for the current file. */
  module: string[];
  /** Names inside that module: ["func"], ["Class", "method"]. */
  symbol: string[];
}

/**
 * The ways to read a dotted Sphinx target, most likely first: "pkg.module.func" is func in pkg/module.py,
 * "shapes.Circle.area" is Circle.area in shapes.py (the plugin only ever tried the second-to-last part as the module,
 * i.e. Circle.py), "module.py.func" is the tolerant filename form, and the current file comes last.
 */
export function symbolLookups(target: string): SymbolLookup[] {
  const parts = target.split('.').filter(Boolean);
  if (parts.length === 0) {
    return [];
  }
  const lookups: SymbolLookup[] = [];
  for (let i = parts.length - 2; i >= 0; i--) {
    let module = parts.slice(0, i + 1);
    if (module.length > 1 && module[module.length - 1].toLowerCase() === 'py') {
      module = module.slice(0, -1); // module.py.func
    } else if (module[module.length - 1].toLowerCase() === 'py' || parts[i + 1].toLowerCase() === 'py') {
      continue; // a split through the ".py" of the filename form
    }
    lookups.push({ module, symbol: parts.slice(i + 1) });
  }
  lookups.push({ module: [], symbol: parts });
  return lookups;
}

/** Module path of a :mod: target or a symbol lookup: "pkg.util" / "util.py" -> ["pkg", "util"] / ["util"]. */
export function modulePath(target: string): string[] {
  return target.replace(/\.py$/i, '').split('.').filter(Boolean);
}
