import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  RunConfiguration,
  RunMode,
  createDefaultConfig,
  normalizePreRunSteps,
} from '../types';
import { ConfigStore } from '../configStore';
import { Runner } from '../runner';
import { EditorContext, getEditorHtml, getNonce } from './configEditorHtml';

export class ConfigEditorProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private currentFolder: vscode.WorkspaceFolder | undefined;
  private currentConfigId: string | undefined;
  private isNew = false;
  /** Whether the open form has edits that have not been written yet. */
  private isDirty = false;

  constructor(
    private context: vscode.ExtensionContext,
    private configStore: ConfigStore,
    private runner: Runner
  ) {}

  async open(
    folder: vscode.WorkspaceFolder,
    config?: RunConfiguration
  ): Promise<void> {
    // Re-opening the configuration already on screen keeps the form as it
    // is, unsaved edits included, rather than re-rendering over them.
    if (
      this.panel &&
      config &&
      config.id === this.currentConfigId &&
      this.currentFolder?.uri.toString() === folder.uri.toString()
    ) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    // Showing a different configuration replaces the form, so anything
    // unsaved would be lost without asking.
    if (this.panel && this.isDirty && !(await this.confirmDiscard())) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.currentFolder = folder;
    this.isNew = !config;
    this.isDirty = false;
    const editConfig = config ?? this.createDefaultConfigForFolder(folder);
    this.currentConfigId = editConfig.id;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        'charmrun.configEditor',
        config ? `Edit: ${config.name}` : 'New Run Configuration',
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          ],
        }
      );

      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentConfigId = undefined;
        this.isDirty = false;
      });

      this.panel.webview.onDidReceiveMessage((message) =>
        this.handleMessage(message)
      );
    }

    this.panel.title = config ? `Edit: ${config.name}` : 'New Run Configuration';
    const nonce = getNonce();
    this.panel.webview.html = getEditorHtml(
      this.panel.webview,
      editConfig,
      nonce,
      await this.buildEditorContext(folder, editConfig.id)
    );
  }

  private createDefaultConfigForFolder(
    folder: vscode.WorkspaceFolder
  ): RunConfiguration {
    const config = createDefaultConfig('New Configuration');
    const envFilePath = path.join(folder.uri.fsPath, '.env');
    if (fs.existsSync(envFilePath)) {
      config.envFile = '${workspaceFolder}/.env';
    }
    return config;
  }

  /**
   * Collects the choices the before-launch section needs: sibling
   * configurations to run, and task labels available in the workspace.
   */
  private async buildEditorContext(
    folder: vscode.WorkspaceFolder,
    currentConfigId: string
  ): Promise<EditorContext> {
    const availableConfigs = this.configStore
      .getConfigurations(folder)
      .filter((config) => config.id !== currentConfigId)
      .map((config) => ({ id: config.id, name: config.name }));

    let availableTasks: string[] = [];
    try {
      const tasks = await vscode.tasks.fetchTasks();
      availableTasks = Array.from(
        new Set(
          tasks.map((task) =>
            task.source && task.source !== 'Workspace'
              ? `${task.source}: ${task.name}`
              : task.name
          )
        )
      ).sort((a, b) => a.localeCompare(b));
    } catch {
      availableTasks = [];
    }

    return { availableConfigs, availableTasks };
  }

  /**
   * Asks whether unsaved edits may be thrown away.
   *
   * @returns true when the user chose to discard them.
   */
  private async confirmDiscard(): Promise<boolean> {
    const discard = 'Discard Changes';
    const choice = await vscode.window.showWarningMessage(
      'This run configuration has unsaved changes.',
      { modal: true, detail: 'Use Apply or Save & Close to keep them.' },
      discard
    );
    return choice === discard;
  }

  /**
   * Writes the edited configuration to the store, without closing the panel.
   * The first successful write of a new configuration adds it; every later
   * write updates it in place, so repeated Apply clicks do not create
   * duplicates.
   *
   * @returns true when the configuration was written.
   */
  private persist(config: RunConfiguration): boolean {
    if (!this.currentFolder) {
      return false;
    }
    config.preRun = normalizePreRunSteps(config.preRun).filter(
      (step) => step.configId !== config.id
    );
    try {
      if (this.isNew) {
        this.configStore.addConfiguration(this.currentFolder, config);
        this.isNew = false;
      } else {
        this.configStore.updateConfiguration(this.currentFolder, config);
      }
    } catch {
      // ConfigStore showed why; keep the form open with the user's edits.
      return false;
    }
    if (this.panel) {
      this.panel.title = `Edit: ${config.name}`;
    }
    this.currentConfigId = config.id;
    this.isDirty = false;
    return true;
  }

  private async handleMessage(message: { command: string; [key: string]: unknown }): Promise<void> {
    switch (message.command) {
      case 'save': {
        if (this.persist(message.config as RunConfiguration)) {
          this.panel?.dispose();
        }
        break;
      }

      case 'apply': {
        if (this.persist(message.config as RunConfiguration)) {
          this.panel?.webview.postMessage({ command: 'applied' });
        }
        break;
      }

      case 'dirtyState':
        this.isDirty = message.dirty === true;
        break;

      case 'run':
      case 'debug': {
        const folder = this.currentFolder;
        if (folder && this.persist(message.config as RunConfiguration)) {
          this.panel?.webview.postMessage({ command: 'applied' });
          await this.runner.execute(
            message.config as RunConfiguration,
            folder,
            message.command as RunMode
          );
        }
        break;
      }

      case 'cancel': {
        if (message.dirty === true && !(await this.confirmDiscard())) {
          break;
        }
        this.panel?.dispose();
        break;
      }

      case 'browseScript': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { Python: ['py'] },
          defaultUri: this.currentFolder?.uri,
        });
        if (result && result[0] && this.currentFolder) {
          const relativePath = path.relative(
            this.currentFolder.uri.fsPath,
            result[0].fsPath
          );
          this.panel?.webview.postMessage({
            command: 'setFilePath',
            field: 'script',
            path: relativePath,
          });
        }
        break;
      }

      case 'browseInterpreter': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: 'Select Python Interpreter',
        });
        if (result && result[0]) {
          this.panel?.webview.postMessage({
            command: 'setFilePath',
            field: 'interpreter',
            path: result[0].fsPath,
          });
        }
        break;
      }

      case 'browseEnvFile': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          openLabel: 'Select Env File',
          defaultUri: this.currentFolder?.uri,
        });
        if (result && result[0] && this.currentFolder) {
          const relativePath = path.relative(
            this.currentFolder.uri.fsPath,
            result[0].fsPath
          );
          this.panel?.webview.postMessage({
            command: 'setFilePath',
            field: 'envFile',
            path: relativePath,
          });
        }
        break;
      }

      case 'browseOutputFile': {
        const result = await vscode.window.showSaveDialog({
          defaultUri: this.currentFolder?.uri,
          saveLabel: 'Select Output File',
        });
        if (result && this.currentFolder) {
          const relativePath = path.relative(
            this.currentFolder.uri.fsPath,
            result.fsPath
          );
          this.panel?.webview.postMessage({
            command: 'setFilePath',
            field: 'outputFile',
            path: relativePath,
          });
        }
        break;
      }

      case 'browseCwd': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select Working Directory',
          defaultUri: this.currentFolder?.uri,
        });
        if (result && result[0]) {
          this.panel?.webview.postMessage({
            command: 'setFilePath',
            field: 'cwd',
            path: result[0].fsPath,
          });
        }
        break;
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
