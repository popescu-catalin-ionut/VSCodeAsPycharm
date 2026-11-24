import * as assert from 'assert';
import { commands, extensions, workspace } from 'vscode';

const REFRESH = 'workbench.files.action.refreshFilesExplorer';

suite('AsPycharm: Refresh Explorer menu entry', () => {
  test('the manifest puts Refresh Explorer in the Explorer context menu', () => {
    const ext = extensions.getExtension('catalinpop.aspycharm');
    assert.ok(ext, 'extension catalinpop.aspycharm is loaded');
    const menu: Array<{ command: string }> = ext!.packageJSON.contributes.menus['explorer/context'];
    assert.ok(menu.some(item => item.command === REFRESH));
  });

  test('VS Code still provides the built-in refresh command the menu entry points to', async () => {
    const all = await commands.getCommands(false);
    assert.ok(all.includes(REFRESH), `${REFRESH} is missing from this VS Code`);
  });
});

suite('AsPycharm: Git merge editor by default', () => {
  test('git.mergeEditor defaults to on, so a conflicted file opens in the 3-way merge editor', () => {
    const inspected = workspace.getConfiguration('git').inspect<boolean>('mergeEditor');
    assert.ok(inspected, 'VS Code\'s Git extension defines git.mergeEditor');
    assert.strictEqual(inspected!.defaultValue, true);
  });

  test('it is only a default: a user setting still wins, and the setting itself stays VS Code\'s', () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    assert.deepStrictEqual(pkg.configurationDefaults, { 'git.mergeEditor': true });
  });
});
