import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { commands, extensions, Uri, window, type ExtensionContext, type WorkspaceFolder } from 'vscode';
import { ConfigStore } from '../../charmrun/configStore';
import { VariableResolver } from '../../charmrun/variableResolver';
import { InterpreterResolver } from '../../charmrun/interpreterResolver';
import { PreRunRunner } from '../../charmrun/preRunRunner';
import { createDefaultConfig, createPreRunStep, normalizePreRunSteps } from '../../charmrun/types';
import { formatArgs, parseArgs } from '../../charmrun/webview/argsText';
import { getEditorHtml } from '../../charmrun/webview/configEditorHtml';

// A workspace folder on a temp directory, and an extension context with an in-memory workspaceState.
function tempFolder(): WorkspaceFolder {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-charmrun-'));
  return { uri: Uri.file(dir), name: path.basename(dir), index: 0 };
}

function fakeContext(): ExtensionContext {
  const state = new Map<string, unknown>();
  return {
    workspaceState: {
      get: (key: string, fallback?: unknown) => (state.has(key) ? state.get(key) : fallback),
      update: async (key: string, value: unknown) => { state.set(key, value); },
      keys: () => [...state.keys()],
    },
  } as unknown as ExtensionContext;
}

const launchPath = (folder: WorkspaceFolder) => path.join(folder.uri.fsPath, '.vscode', 'launch.json');
const writeLaunch = (folder: WorkspaceFolder, text: string) => fs.outputFileSync(launchPath(folder), text);
const readLaunch = (folder: WorkspaceFolder) => fs.readFileSync(launchPath(folder), 'utf8');

// Silences the warning toasts ConfigStore shows, and counts them.
function muteWarnings() {
  const original = window.showWarningMessage;
  const shown: string[] = [];
  Object.assign(window, { showWarningMessage: async (m: string) => { shown.push(m); return undefined; } });
  return { shown, restore: () => Object.assign(window, { showWarningMessage: original }) };
}

const USER_LAUNCH = `{
  // Use IntelliSense to learn about possible attributes.
  "version": "0.2.0",
  "configurations": [
    {
      // my Node config, keep it
      "name": "Node app",
      "type": "node",
      "request": "launch",
      "program": "\${workspaceFolder}/app.js",
    },
    {
      "name": "Py tool",
      "type": "debugpy",
      "request": "launch",
      "program": "tool.py",
      "args": ["--name", "John Smith"],
    },
  ],
}
`;

suite('CharmRun: launch.json store', () => {
  let folder: WorkspaceFolder;
  let store: ConfigStore;
  let warnings: ReturnType<typeof muteWarnings>;

  setup(() => {
    folder = tempFolder();
    store = new ConfigStore(fakeContext());
    warnings = muteWarnings();
  });

  teardown(() => {
    warnings.restore();
    store.dispose();
    fs.removeSync(folder.uri.fsPath);
  });

  function newConfig(name: string, script = 'main.py') {
    const c = createDefaultConfig(name);
    c.script = script;
    return c;
  }

  test('add, update, duplicate and delete managed configurations', () => {
    const a = newConfig('A');
    store.addConfiguration(folder, a);
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['A']);

    store.updateConfiguration(folder, { ...a, name: 'A2', args: ['x'] });
    const [updated] = store.getConfigurations(folder);
    assert.strictEqual(updated.name, 'A2');
    assert.deepStrictEqual(updated.args, ['x']);

    const copy = store.duplicateConfiguration(folder, a.id)!;
    assert.notStrictEqual(copy.id, a.id);
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['A2', 'A2 (Copy)']);

    store.deleteConfiguration(folder, a.id);
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['A2 (Copy)']);
  });

  test('reads a launch.json with comments and trailing commas, as VS Code allows (bug: "failed to read")', () => {
    writeLaunch(folder, USER_LAUNCH.replace('"program": "tool.py",', '"program": "tool.py", "charmrunManaged": true, "charmrunId": "t1",'));
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['Py tool']);
    assert.deepStrictEqual(warnings.shown, [], 'no "failed to read" warning');
  });

  test('saving keeps the other launch.json entries (bug: a trailing comma made it overwrite the whole file)', () => {
    writeLaunch(folder, USER_LAUNCH);
    store.addConfiguration(folder, newConfig('Mine'));
    const text = readLaunch(folder);
    assert.ok(text.includes('"Node app"'), 'Node app entry kept');
    assert.ok(text.includes('"Py tool"'), 'Py tool entry kept');
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['Mine']);
  });

  test('saving keeps comments in launch.json (bug: every save deleted them)', () => {
    writeLaunch(folder, USER_LAUNCH);
    const mine = newConfig('Mine');
    store.addConfiguration(folder, mine);
    store.updateConfiguration(folder, { ...mine, name: 'Mine 2' });
    const text = readLaunch(folder);
    assert.ok(text.includes('// Use IntelliSense to learn about possible attributes.'));
    assert.ok(text.includes('// my Node config, keep it'));
  });

  test('a launch.json with a syntax error is never overwritten', () => {
    const broken = '{ "version": "0.2.0", "configurations": [ { "name": "x" ';
    writeLaunch(folder, broken);
    assert.throws(() => store.addConfiguration(folder, newConfig('Mine')));
    assert.strictEqual(readLaunch(folder), broken);
  });

  test('adopting an entry converts it in place and leaves the rest alone', () => {
    writeLaunch(folder, USER_LAUNCH);
    // entry 1 is the debugpy one
    const adopted = store.adoptConfiguration(folder, 1);
    assert.ok(adopted);
    assert.deepStrictEqual(adopted!.args, ['--name', 'John Smith']);
    const text = readLaunch(folder);
    assert.ok(text.includes('// my Node config, keep it'));
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['Py tool']);
  });

  test('entries copied by hand (same charmrunId) are each kept, and an edit lands on the first (bug: edit lost)', () => {
    const entry = (name: string) =>
      `{ "name": "${name}", "type": "debugpy", "request": "launch", "program": "a.py", "charmrunManaged": true, "charmrunId": "same" }`;
    writeLaunch(folder, `{ "version": "0.2.0", "configurations": [ ${entry('One')}, ${entry('Two')} ] }`);
    const [first] = store.getConfigurations(folder);
    store.updateConfiguration(folder, { ...first, name: 'One edited' });
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['One edited', 'Two']);
  });

  test('saving a configuration deleted meanwhile (e.g. in another window) adds it back (bug: edits silently lost)', () => {
    const gone = newConfig('Gone');
    store.addConfiguration(folder, gone);
    store.deleteConfiguration(folder, gone.id);
    store.updateConfiguration(folder, { ...gone, name: 'Gone, edited' });
    assert.deepStrictEqual(store.getConfigurations(folder).map(c => c.name), ['Gone, edited']);
  });

  test('a broken launch.json is reported once, not on every refresh (bug: 2-3 warnings per save)', () => {
    writeLaunch(folder, '{ "configurations": [ ');
    store.getConfigurations(folder);
    store.getConfigurations(folder);
    store.getConfigurations(folder);
    assert.strictEqual(warnings.shown.length, 1);
    writeLaunch(folder, '{ "configurations": [ { ');
    store.getConfigurations(folder);
    assert.strictEqual(warnings.shown.length, 2, 'a new breakage is reported again');
  });

  test('a new launch.json is created when there is none', () => {
    store.addConfiguration(folder, newConfig('First'));
    const parsed = JSON.parse(readLaunch(folder));
    assert.strictEqual(parsed.version, '0.2.0');
    assert.strictEqual(parsed.configurations[0].charmrunManaged, true);
  });
});

suite('CharmRun: argument text in the editor', () => {
  const CASES: string[][] = [
    [],
    ['a', 'b'],
    ['--name', 'John Smith'],
    [''],
    ['say "hi"'],
    ["it's"],
    ['both \' and "'],
    ['tab\there'],
    ['C:\\Program Files\\x'],
  ];

  test('parse(format(args)) gives back the same arguments (bug: spaces split arguments on save)', () => {
    for (const args of CASES) {
      assert.deepStrictEqual(parseArgs(formatArgs(args)), args, `round trip of ${JSON.stringify(args)}`);
    }
  });

  test('simple arguments stay unquoted', () => {
    assert.strictEqual(formatArgs(['-v', '--count=3', 'x.txt']), '-v --count=3 x.txt');
  });

  test('parse handles quotes and runs of spaces', () => {
    assert.deepStrictEqual(parseArgs('  a   "b c"  \'d e\'  '), ['a', 'b c', 'd e']);
    assert.deepStrictEqual(parseArgs('pre"mid dle"post'), ['premid dlepost']);
  });

  test('the editor page uses the same functions, and escapes config text inside its script', () => {
    const config = createDefaultConfig('</script><img src=x onerror=alert(1)>');
    const fakeWebview = { cspSource: 'vscode-resource:' } as any;
    const html = getEditorHtml(fakeWebview, config, 'NONCE', { availableConfigs: [], availableTasks: [] });
    assert.ok(html.includes("script-src 'nonce-NONCE'"), 'scripts limited by CSP nonce');
    assert.ok(!html.includes('</script><img'), 'config name cannot close the script tag');
    assert.ok(html.includes('function formatArgs') && html.includes('formatArgs(config.args'), 'page formats args');
  });
});

suite('CharmRun: variables, steps and interpreters', () => {
  test('variables: workspace folder, env, and unknown ones left as written', () => {
    const folder = tempFolder();
    process.env.ASPYCHARM_TEST_VAR = 'hello';
    try {
      const r = new VariableResolver(folder);
      assert.strictEqual(r.resolve('${workspaceFolder}/x'), `${folder.uri.fsPath}/x`);
      assert.strictEqual(r.resolve('${workspaceFolderBasename}'), folder.name);
      assert.strictEqual(r.resolve('${env:ASPYCHARM_TEST_VAR}-${env:ASPYCHARM_NOT_SET}'), 'hello-');
      assert.strictEqual(r.resolve('${command:pickArgs}'), '${command:pickArgs}');
    } finally {
      delete process.env.ASPYCHARM_TEST_VAR;
      fs.removeSync(folder.uri.fsPath);
    }
  });

  test('before-launch steps from launch.json are cleaned up; unknown types dropped', () => {
    const steps = normalizePreRunSteps([
      { type: 'externalTool', command: 'make', args: [1, 'b'] },
      { type: 'nonsense' },
      'junk',
      { type: 'task', task: 'build', enabled: false },
    ]);
    assert.deepStrictEqual(steps.map(s => [s.type, s.enabled]), [['externalTool', true], ['task', false]]);
    assert.deepStrictEqual(steps[0].args, ['1', 'b']);
  });

  test('interpreter check: a missing path and a non-Python program are rejected', async () => {
    const resolver = new InterpreterResolver();
    assert.strictEqual(await resolver.check(path.join(os.tmpdir(), 'no-such-dir', 'python.exe')), 'does not exist');
    // VS Code's own executable prints a VS Code version, not "Python x.y".
    const problem = await resolver.check(process.execPath);
    assert.ok(problem && problem.includes('does not look like a Python interpreter'), problem);
  });
});

suite('CharmRun: external tool steps', function () {
  this.timeout(20000);
  let folder: WorkspaceFolder;
  let errors: string[];
  let restoreErrors: () => void;

  setup(() => {
    folder = tempFolder();
    errors = [];
    const original = window.showErrorMessage;
    Object.assign(window, { showErrorMessage: async (m: string) => { errors.push(m); return undefined; } });
    restoreErrors = () => Object.assign(window, { showErrorMessage: original });
  });

  teardown(() => {
    restoreErrors();
    fs.removeSync(folder.uri.fsPath);
  });

  // A tiny tool in folder `dirName`; it writes its first argument to arg.txt and exits with its second.
  let toolDir = '';
  function makeTool(dirName = 'my tools'): string {
    toolDir = path.join(folder.uri.fsPath, dirName);
    const dir = toolDir;
    fs.mkdirpSync(dir);
    if (process.platform === 'win32') {
      const tool = path.join(dir, 'tool.cmd');
      // Delayed expansion, so an "&" inside the argument is not run as a second command by the tool itself.
      fs.writeFileSync(tool, '@echo off\r\nsetlocal EnableDelayedExpansion\r\nset "A=%~1"\r\n> "%~dp0arg.txt" echo(!A!\r\nexit /b %2\r\n');
      return tool;
    }
    const tool = path.join(dir, 'tool.sh');
    fs.writeFileSync(tool, '#!/bin/sh\nprintf "%s" "$1" > "$(dirname "$0")/arg.txt"\nexit ${2:-0}\n', { mode: 0o755 });
    return tool;
  }

  async function runTool(command: string, args: string[]) {
    const output = window.createOutputChannel('AsPycharm test');
    const step = { ...createPreRunStep('externalTool'), command, args, cwd: folder.uri.fsPath };
    const runner = new PreRunRunner(output, async () => true, () => undefined);
    try {
      return await runner.run([step], folder, new Set());
    } finally {
      output.dispose();
    }
  }

  const argFile = () => path.join(toolDir, 'arg.txt');

  test('argument quoting for cmd.exe and for POSIX shells', async () => {
    const { quoteArg } = await import('../../charmrun/preRunRunner');
    assert.strictEqual(quoteArg('plain', 'win32'), 'plain');
    assert.strictEqual(quoteArg('a b', 'win32'), '"a b"');
    assert.strictEqual(quoteArg('a&b', 'win32'), '"a&b"');
    assert.strictEqual(quoteArg('say "hi"', 'win32'), '"say \\"hi\\""');
    assert.strictEqual(quoteArg('C:\\dir\\', 'win32'), '"C:\\dir\\\\"', 'trailing backslash doubled, others kept');
    assert.strictEqual(quoteArg('', 'win32'), '""');
    assert.strictEqual(quoteArg('a b', 'linux'), "'a b'");
    assert.strictEqual(quoteArg("it's $HOME", 'linux'), "'it'\\''s $HOME'");
  });

  test('a tool whose path has a space runs (bug: the path was split at the space)', async () => {
    const tool = makeTool();
    assert.strictEqual(await runTool(tool, ['hello', '0']), true, errors.join('\n'));
    assert.strictEqual(fs.readFileSync(argFile(), 'utf8').trim(), 'hello');
  });

  test('an argument with & reaches the tool as one argument (bug: the shell split the command there)', async () => {
    const tool = makeTool('tools');
    assert.strictEqual(await runTool(tool, ['a&b', '0']), true, errors.join('\n'));
    assert.strictEqual(fs.readFileSync(argFile(), 'utf8').trim(), 'a&b');
  });

  test('a non-zero exit code fails the step and shows why', async () => {
    const tool = makeTool('tools');
    assert.strictEqual(await runTool(tool, ['x', '3']), false);
    assert.ok(errors.some(e => e.includes('exit code 3')), errors.join('\n'));
  });
});

suite('CharmRun: wired into the extension', () => {
  test('Duplicate Configuration from the Command Palette asks which one (bug: did nothing)', async () => {
    const original = window.showInformationMessage;
    const shown: string[] = [];
    Object.assign(window, { showInformationMessage: async (m: string) => { shown.push(m); return undefined; } });
    try {
      await commands.executeCommand('charmrun.duplicateConfiguration');
    } finally {
      Object.assign(window, { showInformationMessage: original });
    }
    // No workspace is open in tests, so the picker reports that there is nothing to pick.
    assert.deepStrictEqual(shown, ['No configurations found.']);
  });

  test('the extension stays off in Restricted Mode (untrusted folders)', () => {
    const ext = extensions.getExtension('catalinpop.aspycharm')!;
    assert.strictEqual(ext.packageJSON.capabilities?.untrustedWorkspaces?.supported, false);
  });

  test('its view, commands and editor icon are contributed and registered', async () => {
    const ext = extensions.getExtension('catalinpop.aspycharm')!;
    const pkg = ext.packageJSON.contributes;
    assert.ok(pkg.views['charmrun-explorer'].some((v: { id: string }) => v.id === 'charmrun.configurationsView'));
    assert.ok(fs.existsSync(path.join(ext.extensionPath, 'resources', 'charmrun', 'icon.svg')));
    const all = await commands.getCommands(true);
    for (const id of ['charmrun.runConfiguration', 'charmrun.debugConfiguration', 'charmrun.openConfigurationFlow',
      'charmrun.runCurrentFile', 'charmrun.selectActiveConfig']) {
      assert.ok(all.includes(id), `${id} is registered`);
    }
  });
});
