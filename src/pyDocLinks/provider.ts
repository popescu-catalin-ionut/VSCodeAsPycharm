// Python Doc Links: Ctrl+Click (Go to Definition) on references in Python docstrings and comments.
// Port of rufatpro/plugins jetbrains/py-doc-links (MIT) to VS Code.
import * as path from 'path';
import {
  CancellationToken, DefinitionProvider, Disposable, FileType, languages, LocationLink, Position, Range, TextDocument,
  Uri, workspace,
} from 'vscode';
import { DocRef, findReferences, modulePath, symbolLookups } from './references';
import { pythonTextRegions, regionAround, TextRegion } from './pythonText';
import { findSymbol, SymbolKind } from './symbols';
import { rankCandidates } from './fileRank';

/** Files in the workspace with this exact name. */
export type FileSearch = (fileName: string) => Promise<Uri[]>;

// Folders a project never means (virtual environments, caches, VCS, dependencies).
const EXCLUDE = '**/{.git,node_modules,.venv,venv,__pycache__,.tox,site-packages}/**';
const MAX_CANDIDATES = 20;

export const workspaceFileSearch: FileSearch = (fileName) =>
  Promise.resolve(workspace.findFiles(`**/${fileName}`, EXCLUDE, 2000));

export function registerPyDocLinks(): Disposable {
  return languages.registerDefinitionProvider({ language: 'python', scheme: 'file' }, new PyDocLinksProvider());
}

export class PyDocLinksProvider implements DefinitionProvider {
  private regions = new WeakMap<TextDocument, { version: number; regions: TextRegion[] }>();

  constructor(private readonly search: FileSearch = workspaceFileSearch) {}

  async provideDefinition(document: TextDocument, position: Position, token?: CancellationToken): Promise<LocationLink[] | undefined> {
    const line = document.lineAt(position.line);
    const lineOffset = document.offsetAt(line.range.start);
    const regions = this.regionsOf(document);
    const ref = findReferences(line.text).find(
      (r) => position.character >= r.start && position.character <= r.end
        && regionAround(regions, lineOffset + r.start, lineOffset + r.end) !== undefined
    );
    if (!ref || token?.isCancellationRequested) {
      return undefined;
    }
    const target = await this.resolve(document, ref);
    if (!target) {
      return undefined;
    }
    return [{
      originSelectionRange: new Range(position.line, ref.start, position.line, ref.end),
      targetUri: target.uri,
      targetRange: target.range,
      targetSelectionRange: target.range,
    }];
  }

  private regionsOf(document: TextDocument): TextRegion[] {
    const cached = this.regions.get(document);
    if (cached?.version === document.version) {
      return cached.regions;
    }
    const regions = pythonTextRegions(document.getText());
    this.regions.set(document, { version: document.version, regions });
    return regions;
  }

  private async resolve(document: TextDocument, ref: DocRef): Promise<{ uri: Uri; range: Range } | undefined> {
    const top = (uri: Uri) => ({ uri, range: new Range(0, 0, 0, 0) });

    if (ref.kind === 'file') {
      const [file] = await this.findFiles(document, ref.target);
      return file && top(file);
    }

    if (ref.kind === 'mod') {
      const module = modulePath(ref.target);
      const [file] = await this.findModule(document, module);
      return file && top(file);
    }

    // A symbol: try each reading of the dotted name; if only the module was found, open it at the top.
    let moduleOnly: Uri | undefined;
    for (const lookup of symbolLookups(ref.target)) {
      const files = lookup.module.length ? await this.findModule(document, lookup.module) : [document.uri];
      for (const uri of files.slice(0, MAX_CANDIDATES)) {
        const text = await this.textOf(uri, document);
        const offset = text === undefined ? -1 : findSymbol(text, lookup.symbol, ref.kind as SymbolKind);
        if (offset >= 0) {
          const at = positionAt(text!, offset);
          return { uri, range: new Range(at, at.translate(0, lookup.symbol[lookup.symbol.length - 1].length)) };
        }
      }
      moduleOnly ??= lookup.module.length ? files[0] : undefined;
    }
    return moduleOnly && top(moduleOnly);
  }

  /** pkg.module -> pkg/module.py, else the package pkg/module/__init__.py. */
  private async findModule(document: TextDocument, module: string[]): Promise<Uri[]> {
    const asFile = await this.findFiles(document, module.join('/') + '.py');
    return asFile.length ? asFile : this.findFiles(document, module.join('/') + '/__init__.py');
  }

  /** "a.py" or "pkg/a.py": next to the source file first, else by name in the workspace, best match first. */
  private async findFiles(document: TextDocument, relative: string): Promise<Uri[]> {
    const source = document.uri.fsPath;
    const nextTo = path.resolve(path.dirname(source), relative);
    if (await isFile(Uri.file(nextTo))) {
      return [Uri.file(nextTo)];
    }
    const found = await this.search(path.basename(relative));
    const ranked = rankCandidates(source, found.map((u) => u.fsPath), relative.includes('/') || relative.includes('\\') ? relative : undefined);
    // A reference with folders (pkg/a.py) goes to a file in such folders; only if there is none, to the best a.py
    // (a package's import name can differ from its folder name).
    const wanted = relative.replace(/\\/g, '/').replace(/^(\.\.?\/)+/, '').toLowerCase();
    const inFolders = ranked.filter((p) => p.replace(/\\/g, '/').toLowerCase().endsWith('/' + wanted));
    return (wanted.includes('/') && inFolders.length ? inFolders : ranked).map((p) => Uri.file(p));
  }

  private async textOf(uri: Uri, current: TextDocument): Promise<string | undefined> {
    if (uri.toString() === current.uri.toString()) {
      return current.getText();
    }
    const open = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      return open.getText(); // unsaved edits included
    }
    try {
      return Buffer.from(await workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }
}

async function isFile(uri: Uri): Promise<boolean> {
  try {
    return ((await workspace.fs.stat(uri)).type & FileType.File) !== 0; // also a symlink to a file
  } catch {
    return false;
  }
}

function positionAt(text: string, offset: number): Position {
  const before = text.slice(0, offset);
  const line = before.split('\n').length - 1;
  return new Position(line, offset - (before.lastIndexOf('\n') + 1));
}
