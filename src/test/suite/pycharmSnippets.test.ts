import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { commands, extensions, Selection, window, workspace } from 'vscode';
import { PRINT_EXPRESSION } from '../../services/printExpression';

type Snippet = { prefix: string | string[]; body: string[]; description: string };

function extension() {
  const ext = extensions.getExtension('catalinpop.aspycharm');
  assert.ok(ext, 'extension catalinpop.aspycharm is loaded');
  return ext!;
}

function loadSnippets(): Record<string, Snippet> {
  const ext = extension();
  const contrib: Array<{ language: string; path: string }> = ext.packageJSON.contributes.snippets;
  const python = contrib.find(s => s.language === 'python');
  assert.ok(python, 'a python snippets file is contributed');
  // Strict JSON on purpose: the original file relied on VS Code tolerating trailing commas.
  return JSON.parse(fs.readFileSync(path.join(ext.extensionPath, python!.path), 'utf8'));
}

function byPrefix(snippets: Record<string, Snippet>, prefix: string): Snippet {
  const found = Object.values(snippets).find(s => ([] as string[]).concat(s.prefix).includes(prefix));
  assert.ok(found, `snippet with prefix "${prefix}" exists`);
  return found!;
}

async function openPython(content: string) {
  const doc = await workspace.openTextDocument({ language: 'python', content });
  return window.showTextDocument(doc);
}

async function closeAll() {
  await commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  await commands.executeCommand('workbench.action.closeAllEditors');
}

// Runs Alt+P's command with the cursor(s) at [line, character] and returns the resulting text.
async function printAt(content: string, ...cursors: Array<[number, number]>) {
  const editor = await openPython(content);
  editor.selections = cursors.map(([l, c]) => new Selection(l, c, l, c));
  const version = editor.document.version;
  try {
    await commands.executeCommand(PRINT_EXPRESSION);
  } catch {
    // a failing command shows up as unchanged text below
  }
  // The original code applied its edit after the command returned, so give a late edit time to land.
  for (let i = 0; i < 20 && editor.document.version === version; i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  const result = { text: editor.document.getText(), cursor: editor.selection.active };
  await closeAll();
  return result;
}

suite('AsPycharm: PyCharm-like Python snippets', () => {
  // Every prefix the original extension (un4gt/pycharm-like-snippets v0.1.0) shipped, plus the documented fori/fore.
  const PREFIXES = [
    'main', 'compd', 'compdi', 'compg', 'compgi', 'compl', 'compli', 'comps', 'compsi', 'iter', 'itere',
    'fori', 'fore', 'prop', 'props', 'propsd', 'deff', 'adef', 'klass', 'klassi', 'forr', 'afor', 'openw',
    'trye', 'tryf', 'tryl', 'whl', 'wth', 'witha', 'awith', 'im', 'ims', 'fim', 'fims',
  ];

  test('every snippet is present, with a body and a description', () => {
    const snippets = loadSnippets();
    for (const p of PREFIXES) {
      const s = byPrefix(snippets, p);
      assert.ok(s.body.length > 0 && s.description, `"${p}" has a body and a description`);
    }
  });

  test('fori / fore exist, as the original README and CHANGELOG promised (bug: only iter / itere shipped)', () => {
    const snippets = loadSnippets();
    assert.strictEqual(byPrefix(snippets, 'fori'), byPrefix(snippets, 'iter'));
    assert.strictEqual(byPrefix(snippets, 'fore'), byPrefix(snippets, 'itere'));
  });

  test('awith ends its first line with ":" (bug: produced invalid Python)', () => {
    assert.match(byPrefix(loadSnippets(), 'awith').body[0], /^async with .*:$/);
  });

  test('no placeholder starts with a space (bug: deff / adef gave "def f( func_args)")', () => {
    for (const [name, s] of Object.entries(loadSnippets())) {
      assert.ok(!/\$\{\d+: /.test(s.body.join('\n')), `"${name}" has a placeholder starting with a space`);
    }
  });

  test('every snippet expands in a Python editor, with no leftover ${...} and its prefix-specific keyword', async function () {
    this.timeout(30000);
    const snippets = loadSnippets();
    for (const [name, s] of Object.entries(snippets)) {
      const editor = await openPython('');
      await commands.executeCommand('editor.action.insertSnippet', { langId: 'python', name });
      const text = editor.document.getText();
      await closeAll();
      assert.ok(text.trim().length > 0, `"${name}" inserted something`);
      assert.ok(!/\$\{|\$\d/.test(text), `"${name}" left a placeholder: ${JSON.stringify(text)}`);
      // The first word of the body (def, class, for, try, ...) must survive expansion.
      const keyword = s.body[0].match(/^[a-z_@]+/i)?.[0];
      if (keyword) {
        assert.ok(text.startsWith(keyword), `"${name}" starts with "${keyword}": ${JSON.stringify(text)}`);
      }
    }
  });

  test('block snippets end their header line with ":" so the result is valid Python', () => {
    const blockStart = /^(async )?(def|class|for|while|with|try|except|else|finally|if)\b/;
    for (const [name, s] of Object.entries(loadSnippets())) {
      for (const line of s.body) {
        const code = line.replace(/^\t+/, '');
        if (blockStart.test(code)) {
          assert.ok(code.trimEnd().endsWith(':'), `"${name}": "${line}" ends with ":"`);
        }
      }
    }
  });

  test('VS Code expands the contributed snippets in a Python editor', async () => {
    const editor = await openPython('');
    await commands.executeCommand('editor.action.insertSnippet', { langId: 'python', name: 'async with statement' });
    const text = editor.document.getText();
    await closeAll();
    assert.match(text.split(/\r?\n/)[0], /^async with .*:$/);
  });

  test('Alt+P is bound to the print command in Python editors, and the command is registered', async () => {
    const keys: Array<{ command: string; key: string; when: string }> = extension().packageJSON.contributes.keybindings;
    const binding = keys.find(k => k.command === PRINT_EXPRESSION);
    assert.ok(binding && binding.key === 'alt+p' && binding.when.includes('editorLangId == python'));
    assert.ok((await commands.getCommands(true)).includes(PRINT_EXPRESSION));
  });
});

suite('AsPycharm: Alt+P wraps the line in print()', () => {
  teardown(closeAll);

  test('cursor at the end of the line: keeps the indentation, cursor after the closing parenthesis', async () => {
    const r = await printAt('if True:\n    fib(int(x))', [1, 15]);
    assert.strictEqual(r.text, 'if True:\n    print(fib(int(x)))');
    assert.deepStrictEqual([r.cursor.line, r.cursor.character], [1, 22]);
  });

  test('cursor in the middle of the line wraps the whole line (bug: command failed)', async () => {
    const r = await printAt('    fib(int(x))', [0, 7]);
    assert.strictEqual(r.text, '    print(fib(int(x)))');
  });

  test('trailing spaces do not mangle the line (bug: produced "    fibprint(fib(3))")', async () => {
    const r = await printAt('    fib(3)   ', [0, 13]);
    assert.strictEqual(r.text, '    print(fib(3))');
  });

  test('a blank line gets print() with the cursor inside the parentheses', async () => {
    const r = await printAt('    ', [0, 4]);
    assert.strictEqual(r.text, '    print()');
    assert.deepStrictEqual([r.cursor.line, r.cursor.character], [0, 10]);
  });

  test('tab indentation and CRLF line endings are kept', async () => {
    const r = await printAt('def f():\r\n\tx + 1\r\n', [1, 2]);
    assert.strictEqual(r.text, 'def f():\r\n\tprint(x + 1)\r\n');
  });

  test('a trailing comment stays outside print() (bug: "print(x  # note)" broke the code)', async () => {
    assert.strictEqual((await printAt('    x + 1  # note', [0, 5])).text, '    print(x + 1)  # note');
    assert.strictEqual((await printAt('f("a # b")  # c', [0, 0])).text, 'print(f("a # b"))  # c');
    assert.strictEqual((await printAt("g('it\\'s # x')", [0, 0])).text, "print(g('it\\'s # x'))");
  });

  test('comment detection skips "#" inside strings, including triple-quoted and escaped ones', async () => {
    const { commentStart } = await import('../../services/printExpression');
    assert.strictEqual(commentStart('x = 1'), -1);
    assert.strictEqual(commentStart('x # c'), 2);
    assert.strictEqual(commentStart('"#" # c'), 4);
    assert.strictEqual(commentStart("'\\'#' # c"), 6);
    assert.strictEqual(commentStart('"""a # b""" # c'), 12);
    assert.strictEqual(commentStart('"unclosed # string'), -1);
  });

  test('a comment-only line is left alone', async () => {
    assert.strictEqual((await printAt('    # just a note', [0, 4])).text, '    # just a note');
  });

  test('two cursors on the same line wrap it once', async () => {
    const r = await printAt('abc', [0, 0], [0, 3]);
    assert.strictEqual(r.text, 'print(abc)');
  });

  test('a selection wraps the line the cursor ends on', async () => {
    const editor = await openPython('a\nb');
    editor.selection = new Selection(0, 0, 1, 1);
    await commands.executeCommand(PRINT_EXPRESSION);
    const text = editor.document.getText();
    await closeAll();
    assert.strictEqual(text, 'a\nprint(b)');
  });

  test('several cursors wrap each of their lines once (bug: only the first line)', async () => {
    const r = await printAt('a\nb\nc', [0, 1], [2, 0], [2, 1]);
    assert.strictEqual(r.text, 'print(a)\nb\nprint(c)');
  });
});
