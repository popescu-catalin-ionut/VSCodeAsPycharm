import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { commands, extensions, languages, Uri, window, workspace } from 'vscode';
import { findConfigForFile, isRunnablePython, temporaryConfigForFile } from '../../charmrun/fileRun';
import { createDefaultConfig } from '../../charmrun/types';

const folder = path.join(os.tmpdir(), 'proj');

function scriptConfig(name: string, script: string, runType: 'script' | 'module' = 'script') {
  const c = createDefaultConfig(name);
  c.runType = runType;
  c.script = script;
  return c;
}

suite('Run / Debug a Python file (PyCharm right-click)', () => {
  test('the configuration that runs the file is found, however its script path is written', () => {
    const file = path.join(folder, 'src', 'main.py');
    const configs = [
      scriptConfig('other', 'other.py'),
      scriptConfig('by module', 'src/main.py', 'module'),
      scriptConfig('relative', 'src/main.py'),
    ];
    assert.strictEqual(findConfigForFile(configs, folder, file)?.name, 'relative');
    assert.strictEqual(findConfigForFile([scriptConfig('wf', '${workspaceFolder}/src/main.py')], folder, file)?.name, 'wf');
    assert.strictEqual(findConfigForFile([scriptConfig('abs', file)], folder, file)?.name, 'abs');
    assert.strictEqual(findConfigForFile([scriptConfig('dotted', './src/../src/main.py')], folder, file)?.name, 'dotted');
    assert.strictEqual(findConfigForFile([scriptConfig('active file', '${file}')], folder, file), undefined, '${file} is not one file');
    assert.strictEqual(findConfigForFile([scriptConfig('other', 'src/other.py')], folder, file), undefined);
    if (process.platform === 'win32') {
      assert.strictEqual(findConfigForFile([scriptConfig('case', 'SRC/Main.py')], folder, file)?.name, 'case', 'Windows paths ignore case');
    }
  });

  test('without one, a temporary configuration named after the file, working in the file\'s folder', () => {
    const nested = temporaryConfigForFile(folder, path.join(folder, 'src', 'app', 'main.py'));
    assert.deepStrictEqual([nested.name, nested.runType, nested.script, nested.cwd], ['main', 'script', 'src/app/main.py', '${workspaceFolder}/src/app']);
    const top = temporaryConfigForFile(folder, path.join(folder, 'tool.py'));
    assert.deepStrictEqual([top.name, top.script, top.cwd, top.envFile], ['tool', 'tool.py', '${workspaceFolder}', '']);
    assert.notStrictEqual(nested.id, top.id);
  });

  test('a temporary configuration picks up the folder\'s .env, as a new configuration does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-filerun-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
      assert.strictEqual(temporaryConfigForFile(dir, path.join(dir, 'main.py')).envFile, '${workspaceFolder}/.env');
    } finally {
      fs.removeSync(dir);
    }
  });

  test('in the Explorer and editor right-click menus for .py files, with PyCharm\'s keys', () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const ids = ['charmrun.runFile', 'charmrun.debugFile', 'charmrun.modifyFileConfiguration'];
    for (const menu of ['explorer/context', 'editor/context']) {
      const items = pkg.menus[menu].filter((m: { command: string }) => ids.includes(m.command));
      assert.deepStrictEqual(items.map((m: { command: string }) => m.command), ids, menu);
      assert.ok(items.every((m: { when: string }) => /\.py|python/.test(m.when)), `${menu}: only for Python files`);
    }
    const keys = Object.fromEntries(pkg.keybindings.filter((k: { command: string }) => ids.includes(k.command)).map((k: { command: string; key: string }) => [k.command, k.key]));
    assert.deepStrictEqual(keys, { 'charmrun.runFile': 'ctrl+shift+f10', 'charmrun.debugFile': 'ctrl+shift+f9' });
  });

  test('runnable: .py and .pyw in any case, or any file open as Python (bug: only lower-case .py)', () => {
    for (const ok of ['main.py', 'MAIN.PY', 'gui.pyw', 'Gui.PYW']) {
      assert.ok(isRunnablePython(path.join(folder, ok)), ok);
    }
    assert.ok(isRunnablePython(path.join(folder, 'manage'), 'python'), 'no extension, open as Python');
    assert.ok(!isRunnablePython(path.join(folder, 'notes.txt'), 'plaintext'));
    assert.ok(!isRunnablePython(path.join(folder, 'pyproject.toml')));
  });

  test('the Explorer menu shows for .PY and .pyw files too (bug: exactly ".py" only)', () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const when: string = pkg.menus['explorer/context'].find((m: { command: string }) => m.command === 'charmrun.runFile').when;
    const m = /resourceExtname =~ \/(.+)\/(\w*)/.exec(when);
    assert.ok(m, when);
    const re = new RegExp(m![1], m![2]);
    assert.deepStrictEqual(['.py', '.PY', '.pyw', '.Pyw', '.pyc', '.pyi', '.txt'].map((e) => re.test(e)), [true, true, true, true, false, false, false]);
  });

  test('a Python file without .py, open as Python, is accepted (bug: "Select a Python (.py) file")', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-filerun-'));
    const errors: string[] = [];
    const original = window.showErrorMessage;
    Object.assign(window, { showErrorMessage: async (m: string) => { errors.push(m); return undefined; } });
    try {
      const file = path.join(dir, 'manage');
      fs.writeFileSync(file, '#!/usr/bin/env python\nprint(1)\n');
      const doc = await languages.setTextDocumentLanguage(await workspace.openTextDocument(Uri.file(file)), 'python');
      assert.strictEqual(doc.languageId, 'python');
      await commands.executeCommand('charmrun.runFile', Uri.file(file));
    } finally {
      Object.assign(window, { showErrorMessage: original });
      await commands.executeCommand('workbench.action.closeAllEditors');
      try { fs.removeSync(dir); } catch { /* still held by VS Code: a temp folder */ }
    }
    // Accepted as Python; it then stops only because the test VS Code has no folder open.
    assert.strictEqual(errors.length, 1);
    assert.ok(errors[0].includes('is not in an open folder'), errors[0]);
  });

  test('no VS Code default command uses Ctrl+Shift+F10 / Ctrl+Shift+F9 in a Python editor', async () => {
    await commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    const text = window.activeTextEditor?.document.getText() ?? '';
    await commands.executeCommand('workbench.action.closeActiveEditor');
    assert.ok(text.includes('"key"'), 'read the default keybindings');
    for (const key of ['ctrl+shift+f10', 'ctrl+shift+f9']) {
      const entries = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0])
        .filter((e) => new RegExp(`"key":\\s*"${key.replace(/\+/g, '\\+')}"`).test(e))
        .filter((e) => !/"command":\s*"(charmrun\.|-)/.test(e));
      // Ctrl+Shift+F9 is also the Chat view's "previous file tree", which only applies inside Chat (inChat).
      const clashing = entries.filter((e) => !/"when":\s*"[^"]*\binChat\b/.test(e));
      assert.deepStrictEqual(clashing, [], `${key} is free in editors`);
    }
  });

  test('the commands explain what is wrong instead of failing silently', async () => {
    const errors: string[] = [];
    const original = window.showErrorMessage;
    Object.assign(window, { showErrorMessage: async (m: string) => { errors.push(m); return undefined; } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-filerun-'));
    try {
      fs.writeFileSync(path.join(dir, 'notes.txt'), '');
      fs.writeFileSync(path.join(dir, 'main.py'), 'print(1)\n');
      await commands.executeCommand('charmrun.runFile', Uri.file(path.join(dir, 'notes.txt')));
      // The test VS Code has no folder open, so a .py file is outside any workspace folder.
      await commands.executeCommand('charmrun.debugFile', Uri.file(path.join(dir, 'main.py')));
      await commands.executeCommand('charmrun.modifyFileConfiguration', Uri.file(path.join(dir, 'main.py')));
    } finally {
      Object.assign(window, { showErrorMessage: original });
      fs.removeSync(dir);
    }
    assert.strictEqual(errors.length, 3, errors.join('\n'));
    assert.ok(errors[0].includes('Python (.py) file'));
    assert.ok(errors[1].includes('main.py is not in an open folder') && errors[2].includes('Open its folder'));
    assert.strictEqual(workspace.workspaceFolders, undefined);
  });
});
