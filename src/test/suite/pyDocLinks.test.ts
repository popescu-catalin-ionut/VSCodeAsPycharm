import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { commands, Position, Uri, window, workspace, type LocationLink, type TextDocument } from 'vscode';
import { findReferences, symbolLookups } from '../../pyDocLinks/references';
import { pythonTextRegions } from '../../pyDocLinks/pythonText';
import { findSymbol } from '../../pyDocLinks/symbols';
import { rankCandidates } from '../../pyDocLinks/fileRank';
import { PyDocLinksProvider, type FileSearch } from '../../pyDocLinks/provider';

const refs = (text: string) => findReferences(text).map((r) => `${r.kind}:${r.target}`);

suite('Python Doc Links: finding references', () => {
  test('the plugin\'s patterns: filename.py and the Sphinx roles, long and short', () => {
    assert.deepStrictEqual(refs('see submodule.py and my-file.py'), ['file:submodule.py', 'file:my-file.py']);
    assert.deepStrictEqual(refs(':py:func:`submodule.process_submodule_data`'), ['func:submodule.process_submodule_data']);
    assert.deepStrictEqual(refs(':py:func:`submodule.py.process_submodule_data`'), ['func:submodule.py.process_submodule_data']);
    assert.deepStrictEqual(refs(':func:`run_main_flow`'), ['func:run_main_flow']);
    assert.deepStrictEqual(refs(':py:class:`ObjectWithProperties` :class:`A`'), ['class:ObjectWithProperties', 'class:A']);
    assert.deepStrictEqual(refs(':py:data:`config.hosters_data` :data:`X`'), ['data:config.hosters_data', 'data:X']);
    assert.deepStrictEqual(refs(':py:attr:`Box.size` :attr:`size`'), ['attr:Box.size', 'attr:size']);
    assert.deepStrictEqual(refs(':py:mod:`submodule` :py:mod:`submodule.py`'), ['mod:submodule', 'mod:submodule.py']);
  });

  test('Sphinx forms the plugin missed: :mod:, :meth:, :exc:, :obj:, "title <target>", "~target", "target()"', () => {
    assert.deepStrictEqual(refs(':mod:`pkg.util`'), ['mod:pkg.util']);
    assert.deepStrictEqual(refs(':meth:`Service.start` :py:meth:`a.B.c`'), ['meth:Service.start', 'meth:a.B.c']);
    assert.deepStrictEqual(refs(':exc:`errors.Boom` :obj:`thing`'), ['class:errors.Boom', 'any:thing']);
    assert.deepStrictEqual(refs(':func:`the helper <util.helper>`'), ['func:util.helper']);
    assert.deepStrictEqual(refs(':func:`~util.helper`'), ['func:util.helper']);
    assert.deepStrictEqual(refs(':func:`util.helper()`'), ['func:util.helper']);
  });

  test('a file path keeps its folders (the plugin kept only main.py)', () => {
    assert.deepStrictEqual(refs('see pkg/a/main.py'), ['file:pkg/a/main.py']);
    assert.deepStrictEqual(refs('see ..\\x\\y.py'), ['file:..\\x\\y.py']);
  });

  test('the range covers only the target, and overlapping matches keep the Sphinx one', () => {
    const text = 'x :py:mod:`module.py` y';
    const [ref] = findReferences(text);
    assert.strictEqual(text.slice(ref.start, ref.end), 'module.py');
    assert.strictEqual(findReferences(text).length, 1);
    assert.deepStrictEqual(refs('a.pyc b.pyx'), []);
  });

  test('dotted names are tried as module + symbol, longest module first, current file last', () => {
    const show = (t: string) => symbolLookups(t).map((l) => `${l.module.join('.')}|${l.symbol.join('.')}`);
    assert.deepStrictEqual(show('pkg.module.func'), ['pkg.module|func', 'pkg|module.func', '|pkg.module.func']);
    assert.deepStrictEqual(show('shapes.Circle.area'), ['shapes.Circle|area', 'shapes|Circle.area', '|shapes.Circle.area']);
    assert.deepStrictEqual(show('module.py.func'), ['module|func', '|module.py.func']);
    assert.deepStrictEqual(show('func'), ['|func']);
  });
});

suite('Python Doc Links: strings, comments and definitions', () => {
  test('string and comment regions: quotes, triple quotes, escapes, prefixes, unclosed strings', () => {
    const text = 'a = "x # y"  # real\nb = r\'\\\'\'\nc = """\nmulti # line\n"""\nd = "open\ne = 1';
    const shown = pythonTextRegions(text).map((r) => `${r.kind}:${text.slice(r.start, r.end)}`);
    assert.deepStrictEqual(shown, [
      'string:"x # y"', 'comment:# real', "string:'\\''", 'string:"""\nmulti # line\n"""', 'string:"open',
    ]);
  });

  test('def, class and assignment, in the order each role asks for', () => {
    const src = 'X = 1\nclass X:\n    pass\ndef X():\n    pass\n';
    const lineOf = (offset: number) => src.slice(0, offset).split('\n').length;
    assert.strictEqual(lineOf(findSymbol(src, ['X'], 'func')), 4);
    assert.strictEqual(lineOf(findSymbol(src, ['X'], 'class')), 2);
    assert.strictEqual(lineOf(findSymbol(src, ['X'], 'data')), 1);
    assert.strictEqual(findSymbol(src, ['Y'], 'func'), -1);
    assert.strictEqual(src.slice(findSymbol(src, ['X'], 'func'), findSymbol(src, ['X'], 'func') + 1), 'X', 'points at the name');
  });

  test('Class.method is looked up inside the class (the plugin looked for a file Class.py)', () => {
    const src = 'def area():\n    pass\nclass Circle:\n    def area(self):\n        pass\n';
    assert.strictEqual(src.slice(0, findSymbol(src, ['Circle', 'area'], 'meth')).split('\n').length, 4);
    assert.strictEqual(findSymbol(src, ['Square', 'area'], 'meth'), -1);
  });

  test('the module-level variable wins over a local one (the plugin took the first, a local)', () => {
    const src = 'def f():\n    LIMIT = 1\nLIMIT = 10\n';
    assert.strictEqual(src.slice(0, findSymbol(src, ['LIMIT'], 'data')).split('\n').length, 3);
  });

  test('"LIMIT == 3" is not an assignment (the plugin matched it)', () => {
    assert.strictEqual(findSymbol('if True:\n    LIMIT == 3\n', ['LIMIT'], 'data'), -1);
    assert.ok(findSymbol('LIMIT: int = 3\n', ['LIMIT'], 'data') >= 0, 'annotated assignment');
  });

  test('"def run(" inside a docstring is not the definition (the plugin jumped there)', () => {
    const src = 'X = """\ndef run(): example\n"""\n\ndef run():\n    pass\n';
    assert.strictEqual(src.slice(0, findSymbol(src, ['run'], 'func')).split('\n').length, 5);
  });

  test(':attr: finds self.name = ... inside the class when there is no class-level one', () => {
    const src = 'class Box:\n    def __init__(self):\n        self.size = 3\n';
    assert.strictEqual(src.slice(0, findSymbol(src, ['Box', 'size'], 'attr')).split('\n').length, 3);
  });

  test('several files with the same name: same folder first, docs/ and examples/ last, named folders win', () => {
    const src = path.join('r', 'app', 'run.py');
    const cands = [path.join('r', 'docs', 'main.py'), path.join('r', 'other', 'main.py'), path.join('r', 'app', 'main.py')];
    assert.strictEqual(rankCandidates(src, cands)[0], path.join('r', 'app', 'main.py'));
    assert.strictEqual(rankCandidates(src, [cands[0], cands[1]])[0], path.join('r', 'other', 'main.py'));
    assert.strictEqual(rankCandidates(src, cands, 'docs/main.py')[0], path.join('r', 'docs', 'main.py'));
  });
});

suite('Python Doc Links: Ctrl+Click in a Python file', function () {
  this.timeout(20000);
  let root: string;
  let doc: TextDocument;
  let provider: PyDocLinksProvider;

  // The test VS Code has no workspace open, so the workspace search is replaced by a walk of the temp project.
  const walkSearch: FileSearch = async (name) => {
    const found: Uri[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); } else if (entry.name === name) { found.push(Uri.file(full)); }
      }
    };
    walk(root);
    return found;
  };

  const MAIN = [
    '"""Module doc.',
    '',
    'File: submodule.py',
    'Function: :py:func:`submodule.process_submodule_data`',
    'Filename form: :py:func:`submodule.py.process_submodule_data`',
    'Current module: :func:`run_main_flow`',
    'Variable: :py:data:`config.hosters_data`',
    'Class: :py:class:`submodule.ObjectWithProperties`',
    'Module: :py:mod:`submodule`',
    'Method: :meth:`shapes.Circle.area`',
    'Same-file method: :meth:`Local.go`',
    'Titled: :func:`the helper <pkg.util.helper>`',
    'Package: :mod:`pkg`',
    'Path: a/main.py',
    'Missing: :func:`submodule.no_such_func`',
    '"""',
    'import submodule  # see config.py',
    'name = "submodule.py"',
    'value = submodule.py',
    '',
    'class Local:',
    '    def go(self):',
    '        pass',
    '',
    'def run_main_flow():',
    '    pass',
    '',
  ].join('\n');

  suiteSetup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-pydoc-'));
    const write = (rel: string, text: string) => fs.outputFileSync(path.join(root, 'app', rel), text);
    write('main.py', MAIN);
    write('submodule.py', 'class ObjectWithProperties:\n    pass\n\ndef process_submodule_data():\n    pass\n');
    write('config.py', 'hosters_data = {}\n');
    write('shapes.py', 'def area():\n    pass\nclass Circle:\n    def area(self):\n        pass\n');
    write('pkg/__init__.py', '');
    write('pkg/util.py', 'def helper():\n    pass\n');
    write('pkg/a/main.py', '# the one\n');
    write('docs/pkg/b/main.py', '# not this one\n');
    provider = new PyDocLinksProvider(walkSearch);
    doc = await workspace.openTextDocument(Uri.file(path.join(root, 'app', 'main.py')));
  });

  suiteTeardown(async () => {
    await commands.executeCommand('workbench.action.closeAllEditors');
    fs.removeSync(root);
  });

  // Go to Definition with the cursor on `needle` (in the line containing `onLine`, or its first occurrence).
  async function goTo(needle: string, onLine = needle): Promise<{ file: string; line: string; origin: string } | undefined> {
    const lineNo = doc.getText().split('\n').findIndex((l) => l.includes(onLine));
    const col = doc.lineAt(lineNo).text.indexOf(needle) + 1;
    const links = (await provider.provideDefinition(doc, new Position(lineNo, col))) as LocationLink[] | undefined;
    if (!links?.length) {
      return undefined;
    }
    const target = await workspace.openTextDocument(links[0].targetUri);
    return {
      file: path.relative(path.join(root, 'app'), links[0].targetUri.fsPath).split(path.sep).join('/'),
      line: target.lineAt(links[0].targetRange.start.line).text.trim(),
      origin: doc.getText(links[0].originSelectionRange),
    };
  }

  test('filename.py opens the file; the link covers the name', async () => {
    assert.deepStrictEqual(await goTo('submodule.py', 'File:'), { file: 'submodule.py', line: 'class ObjectWithProperties:', origin: 'submodule.py' });
  });

  test(':py:func: in module form and filename form', async () => {
    assert.strictEqual((await goTo('process_submodule_data', 'Function:'))?.line, 'def process_submodule_data():');
    assert.strictEqual((await goTo('process_submodule_data', 'Filename form:'))?.line, 'def process_submodule_data():');
  });

  test(':func: of the current module, :py:data:, :py:class:, :py:mod:', async () => {
    assert.deepStrictEqual(await goTo('run_main_flow'), { file: 'main.py', line: 'def run_main_flow():', origin: 'run_main_flow' });
    assert.strictEqual((await goTo('hosters_data'))?.line, 'hosters_data = {}');
    assert.strictEqual((await goTo('ObjectWithProperties', 'Class:'))?.line, 'class ObjectWithProperties:');
    assert.strictEqual((await goTo('submodule', 'Module:'))?.file, 'submodule.py');
  });

  test(':meth: in another module and in the current file; a titled target; a package', async () => {
    assert.deepStrictEqual(await goTo('Circle.area'), { file: 'shapes.py', line: 'def area(self):', origin: 'shapes.Circle.area' });
    assert.strictEqual((await goTo('Local.go'))?.line, 'def go(self):');
    assert.strictEqual((await goTo('pkg.util.helper'))?.line, 'def helper():');
    assert.strictEqual((await goTo('pkg', 'Package:'))?.file, 'pkg/__init__.py');
  });

  test('a path picks the file in those folders, not the main.py next door (the plugin dropped the folders)', async () => {
    assert.strictEqual((await goTo('a/main.py'))?.file, 'pkg/a/main.py');
  });

  test('an unknown function still opens its module', async () => {
    assert.strictEqual((await goTo('no_such_func'))?.file, 'submodule.py');
  });

  test('references work in comments and strings, but not in code', async () => {
    assert.strictEqual((await goTo('config.py', '# see'))?.file, 'config.py');
    assert.strictEqual((await goTo('submodule.py', 'name ='))?.file, 'submodule.py');
    assert.strictEqual(await goTo('submodule.py', 'value ='), undefined);
  });

  test('registered with VS Code: Go to Definition works through the real provider', async () => {
    // Uses the workspace search; the file is next to main.py, which is found without a workspace.
    await window.showTextDocument(doc);
    const lineNo = doc.getText().split('\n').findIndex((l) => l.startsWith('File:'));
    const links = await commands.executeCommand<LocationLink[]>('vscode.executeDefinitionProvider', doc.uri, new Position(lineNo, 8));
    assert.ok(links.some((l) => ((l as LocationLink).targetUri ?? (l as any).uri).fsPath.endsWith('submodule.py')));
  });
});
