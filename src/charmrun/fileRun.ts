// PyCharm's right-click on a Python file: Run 'main', Debug 'main', Modify Run Configuration...
// Uses the CharmRun configuration that runs that file; if there is none, a temporary one named after the file
// (as PyCharm does), which is only saved to launch.json when you save it from Modify Run Configuration.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigStore } from './configStore';
import { Runner } from './runner';
import { ConfigEditorProvider } from './webview/configEditorProvider';
import { createDefaultConfig, RunConfiguration, RunMode } from './types';

/**
 * A file these commands can run: .py or .pyw in any letter case (MAIN.PY on Windows), or any file VS Code has
 * open as Python (a script without an extension, with a "#!/usr/bin/env python" line).
 */
export function isRunnablePython(fsPath: string, languageId?: string): boolean {
  return /\.pyw?$/i.test(fsPath) || languageId === 'python';
}

const sameFile = (a: string, b: string) =>
  process.platform === 'win32' ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b);

/** The script configuration that runs `file` (its path relative, absolute, or with ${workspaceFolder}). */
export function findConfigForFile(configs: RunConfiguration[], folderPath: string, file: string): RunConfiguration | undefined {
  return configs.find((c) => {
    if (c.runType !== 'script' || !c.script.trim()) {
      return false;
    }
    const script = c.script.replace(/\$\{workspaceFolder\}/g, folderPath);
    if (script.includes('${')) {
      return false; // depends on the active editor (${file}, ...): not a configuration for one file
    }
    return sameFile(path.resolve(folderPath, script), file);
  });
}

/** PyCharm's temporary configuration: named after the file, working directory = the file's folder. */
export function temporaryConfigForFile(folderPath: string, file: string): RunConfiguration {
  const config = createDefaultConfig(path.basename(file, path.extname(file)));
  const relative = path.relative(folderPath, file).split(path.sep).join('/');
  const dir = path.posix.dirname(relative);
  config.script = relative;
  config.cwd = dir === '.' ? '${workspaceFolder}' : `\${workspaceFolder}/${dir}`;
  if (fs.existsSync(path.join(folderPath, '.env'))) {
    config.envFile = '${workspaceFolder}/.env';
  }
  return config;
}

export function registerFileRunCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  runner: Runner,
  editorProvider: ConfigEditorProvider
): void {
  /** The file (from the Explorer or the editor), its workspace folder, and its configuration. */
  const prepare = (uri?: vscode.Uri) => {
    const file = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    const open = file && vscode.workspace.textDocuments.find((d) => d.uri.toString() === file.toString());
    if (!file || file.scheme !== 'file' || !isRunnablePython(file.fsPath, open?.languageId)) {
      void vscode.window.showErrorMessage('CharmRun: Select a Python (.py) file to run.');
      return undefined;
    }
    const folder = vscode.workspace.getWorkspaceFolder(file);
    if (!folder) {
      void vscode.window.showErrorMessage(
        `CharmRun: ${path.basename(file.fsPath)} is not in an open folder. Open its folder (File > Open Folder) to run it.`
      );
      return undefined;
    }
    const saved = findConfigForFile(configStore.getConfigurations(folder), folder.uri.fsPath, file.fsPath);
    return { folder, config: saved ?? temporaryConfigForFile(folder.uri.fsPath, file.fsPath), saved: Boolean(saved) };
  };

  const run = (mode: RunMode) => async (uri?: vscode.Uri) => {
    const target = prepare(uri);
    if (!target) {
      return;
    }
    if (target.saved) {
      configStore.setActiveConfigId(target.config.id); // as PyCharm selects it in the toolbar
    }
    await runner.execute(target.config, target.folder, mode);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.runFile', run('run')),
    vscode.commands.registerCommand('charmrun.debugFile', run('debug')),
    vscode.commands.registerCommand('charmrun.modifyFileConfiguration', async (uri?: vscode.Uri) => {
      const target = prepare(uri);
      if (target) {
        await editorProvider.open(target.folder, target.config, !target.saved);
      }
    })
  );
}
