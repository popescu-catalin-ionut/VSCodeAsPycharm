import * as assert from 'assert';
import { commands, extensions } from 'vscode';

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
