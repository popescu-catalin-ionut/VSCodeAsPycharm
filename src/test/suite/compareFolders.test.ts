import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { Uri } from 'vscode';
import { compareFolders } from '../../services/comparer';
import { compareName } from '../../services/ignoreExtensionTools';
import { pathContext } from '../../context/path';
import { uiContext } from '../../context/ui';
import { CompareFoldersProvider } from '../../providers/foldersCompareProvider';
import { ViewOnlyProvider } from '../../providers/viewOnlyProvider';
import { File } from '../../models/file';
import { mockConfiguration } from './mocks/configuration';

// Two temp folders filled from { 'relative/path': content }; undefined content = file absent on that side.
function makeFolders(files: Record<string, [string | undefined, string | undefined]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-cmp-'));
  const left = path.join(root, 'left');
  const right = path.join(root, 'right');
  fs.mkdirpSync(left);
  fs.mkdirpSync(right);
  for (const [rel, [l, r]] of Object.entries(files)) {
    if (l !== undefined) { fs.outputFileSync(path.join(left, rel), l); }
    if (r !== undefined) { fs.outputFileSync(path.join(right, rel), r); }
  }
  return { root, left, right };
}

const BASE_CONFIG = {
  compareContent: true,
  ignoreFileNameCase: true,
  showIdentical: false,
  defaultDiffViewMode: 'list',
};

function rel(base: string, paths: string[][]) {
  return paths.map(([p]) => path.relative(base, p).split(path.sep).join('/')).sort();
}

suite('Compare Folders: filters and actions on real folders', () => {
  let restore: (() => void) | undefined;
  let root: string | undefined;

  teardown(() => {
    restore?.();
    restore = undefined;
    if (root) { fs.removeSync(root); }
    root = undefined;
  });

  async function compare(config: Record<string, unknown>, files: Record<string, [string | undefined, string | undefined]>) {
    const f = makeFolders(files);
    root = f.root;
    restore = mockConfiguration({ ...BASE_CONFIG, ...config });
    pathContext.setPaths(f.left, f.right);
    return { ...f, result: await compareFolders() };
  }

  test('finds distinct files and files on one side only', async () => {
    const { left, right, result } = await compare({}, {
      'same.txt': ['a', 'a'],
      'changed.txt': ['a', 'b'],
      'sub/onlyLeft.txt': ['x', undefined],
      'onlyRight.txt': [undefined, 'y'],
    });
    assert.deepStrictEqual(rel(left, result.distinct), ['changed.txt']);
    assert.deepStrictEqual(rel(left, result.left), ['sub/onlyLeft.txt']);
    assert.deepStrictEqual(rel(right, result.right), ['onlyRight.txt']);
  });

  test('excludeFilter with a brace pattern excludes every listed extension (bug: split on the comma)', async () => {
    const { left, result } = await compare({ excludeFilter: ['**/*.{log,tmp}'] }, {
      'a.log': ['1', '2'],
      'b.tmp': ['1', '2'],
      'c.txt': ['1', '2'],
    });
    assert.deepStrictEqual(rel(left, result.distinct), ['c.txt']);
  });

  test('includeFilter with a brace pattern includes every listed extension', async () => {
    const { left, result } = await compare({ includeFilter: ['*.{js,ts}'] }, {
      'a.js': ['1', '2'],
      'b.ts': ['1', '2'],
      'c.txt': ['1', '2'],
    });
    assert.deepStrictEqual(rel(left, result.distinct), ['a.js', 'b.ts']);
  });

  test('brace expansion: plain, single, nested and repeated groups', async () => {
    const { expandBraces } = await import('../../services/includeExcludeFilesGetter');
    assert.deepStrictEqual(expandBraces('**/node_modules'), ['**/node_modules']);
    assert.deepStrictEqual(expandBraces('*.{js,ts}'), ['*.js', '*.ts']);
    assert.deepStrictEqual(expandBraces('{a,b}/{x,y}').sort(), ['a/x', 'a/y', 'b/x', 'b/y']);
    assert.deepStrictEqual(expandBraces('*.{a,{b,c}}').sort(), ['*.a', '*.b', '*.c']);
    assert.deepStrictEqual(expandBraces('{solo}.txt'), ['{solo}.txt'], 'a group without a comma stays as written');
  });

  test('ignoreExtension pairs names whose extension also appears earlier in the name', () => {
    const options = { ignoreExtension: [['php', 'cs']], ignoreCase: false } as any;
    assert.strictEqual(compareName('a.php', 'a.cs', options), 0);
    assert.strictEqual(compareName('a.php.php', 'a.php.cs', options), 0);
    assert.notStrictEqual(compareName('a.php', 'b.cs', options), 0);
  });

  suite('Differences view actions', () => {
    let provider: CompareFoldersProvider;

    function itemFor(name: string): File | undefined {
      return provider.getChildren().find(i => i.label === name);
    }

    async function setUp(files: Record<string, [string | undefined, string | undefined]>) {
      const f = makeFolders(files);
      root = f.root;
      restore = mockConfiguration({ ...BASE_CONFIG, excludeFilter: [] });
      uiContext.diffViewMode = 'list';
      provider = new CompareFoldersProvider(new ViewOnlyProvider(), new ViewOnlyProvider(), new ViewOnlyProvider(false));
      pathContext.setPaths(f.left, f.right);
      await provider.refresh(true, false);
      return f;
    }

    teardown(() => {
      uiContext.diffViewMode = 'tree';
    });

    test('Dismiss hides the file from the Differences view (bug: did nothing on Windows)', async () => {
      await setUp({ 'a.txt': ['1', '2'], 'b.txt': ['1', '2'] });
      assert.ok(itemFor('a.txt'));
      await provider.dismissDifference(itemFor('a.txt')!);
      assert.strictEqual(itemFor('a.txt'), undefined, 'a.txt is gone');
      assert.ok(itemFor('b.txt'), 'b.txt is still listed');
    });

    test('Exclude from Comparison excludes a file in a subfolder', async () => {
      await setUp({ 'sub/a.txt': ['1', '2'], 'b.txt': ['1', '2'] });
      const item = itemFor('a.txt');
      assert.ok(item);
      await provider.excludeFromComparison(item!);
      assert.strictEqual(itemFor('a.txt'), undefined, 'sub/a.txt is excluded');
      assert.ok(itemFor('b.txt'));
    });
  });
});

suite('Compare Folders: tree view with unusual folder and file names', () => {
  // Folder and file names that clash with JavaScript object properties or with the tree's own fields.
  const NAMES = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'path', 'relativePath'];

  function labels(items: File[]): string[] {
    return items.flatMap(i => [String(i.label), ...labels(i.children ?? []).map(c => `${i.label}/${c}`)]);
  }

  test('every file shows up in tree mode (bug: lost or crashed on these names)', async () => {
    const { build } = await import('../../services/treeBuilder');
    uiContext.diffViewMode = 'tree';
    const base = path.join(os.tmpdir(), 'base');
    const files = NAMES.flatMap(n => [path.join(base, n, 'file.txt'), path.join(base, 'dir', n)]);
    const { treeItems } = build(files.map(f => [f, f + '2'] as [string, string]), base);
    const shown = labels(treeItems);
    for (const f of files) {
      const r = path.relative(base, f).split(path.sep).join('/');
      assert.ok(shown.includes(r), `${r} is shown (got ${JSON.stringify(shown)})`);
    }
  });

  test('a folder item points at the folder, and a file item at its file', async () => {
    const { build } = await import('../../services/treeBuilder');
    uiContext.diffViewMode = 'tree';
    const base = path.join(os.tmpdir(), 'base');
    const file = path.join(base, 'sub', 'path');
    const [folder] = build([[file, file + '2']], base).treeItems;
    assert.strictEqual(folder.resourceUri?.fsPath, Uri.file(path.join(base, 'sub')).fsPath);
    assert.strictEqual(folder.children?.[0].resourceUri?.fsPath, Uri.file(file).fsPath);
  });
});
