import * as vscode from 'vscode';
import { ConfigStore } from './configStore';
import { ConfigTreeProvider } from './treeView/configTreeProvider';
import { ConfigEditorProvider } from './webview/configEditorProvider';
import { StatusBarManager } from './statusBar';
import { Runner } from './runner';
import { registerCommands } from './commands';
import { registerFileRunCommands } from './fileRun';

let outputChannel: vscode.OutputChannel | undefined;

export function activateCharmRun(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('PyCharm-style Run');
  context.subscriptions.push(outputChannel);

  try {
    outputChannel.appendLine('Activating PyCharm-style Run');

    const configStore = new ConfigStore(context);
    const treeProvider = new ConfigTreeProvider(configStore);
    const runner = new Runner(configStore, outputChannel);
    const editorProvider = new ConfigEditorProvider(context, configStore, runner);
    const statusBar = new StatusBarManager(configStore);

    registerCommands(context, configStore, treeProvider, editorProvider, statusBar, runner);
    registerFileRunCommands(context, configStore, runner, editorProvider);
    outputChannel.appendLine('Commands registered');

    const treeView = vscode.window.createTreeView('charmrun.configurationsView', {
      treeDataProvider: treeProvider,
      showCollapseAll: false,
    });
    outputChannel.appendLine('Tree view created');

    statusBar.show();
    outputChannel.appendLine('Status bar shown');

    context.subscriptions.push(treeView, configStore, statusBar, editorProvider, runner);
    outputChannel.appendLine('PyCharm-style Run activation complete');
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    outputChannel.appendLine(`Activation failed: ${message}`);
    void vscode.window.showErrorMessage('PyCharm-style Run failed to activate. See Output > PyCharm-style Run for details.');
  }
}

