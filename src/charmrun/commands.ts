import * as vscode from 'vscode';
import { ConfigStore } from './configStore';
import { Runner } from './runner';
import { ConfigEditorProvider } from './webview/configEditorProvider';
import { ConfigTreeProvider } from './treeView/configTreeProvider';
import { ConfigTreeItem } from './treeView/configTreeItem';
import { StatusBarManager } from './statusBar';

export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  treeProvider: ConfigTreeProvider,
  editorProvider: ConfigEditorProvider,
  statusBar: StatusBarManager,
  runner: Runner
): void {
  // Run the active configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.runConfiguration', async () => {
      const activeId = configStore.getActiveConfigId();
      if (!activeId) {
        vscode.window.showInformationMessage(
          'CharmRun: No active configuration selected.'
        );
        return;
      }
      const found = configStore.findConfigById(activeId);
      if (!found) {
        vscode.window.showErrorMessage(
          'CharmRun: Active configuration not found.'
        );
        return;
      }
      await runner.execute(found.config, found.folder, 'run');
    })
  );

  // Debug the active configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.debugConfiguration', async () => {
      const activeId = configStore.getActiveConfigId();
      if (!activeId) {
        vscode.window.showInformationMessage(
          'CharmRun: No active configuration selected.'
        );
        return;
      }
      const found = configStore.findConfigById(activeId);
      if (!found) {
        vscode.window.showErrorMessage(
          'CharmRun: Active configuration not found.'
        );
        return;
      }
      await runner.execute(found.config, found.folder, 'debug');
    })
  );

  // Run current Python file
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.runCurrentFile', async () => {
      const folder = await getWorkspaceFolderForActiveEditor();
      if (folder) {
        await runner.runCurrentFile(folder, 'run');
      }
    })
  );

  // Debug current Python file
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.debugCurrentFile', async () => {
      const folder = await getWorkspaceFolderForActiveEditor();
      if (folder) {
        await runner.runCurrentFile(folder, 'debug');
      }
    })
  );

  // Create configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.createConfiguration', async () => {
      const folder = await getWorkspaceFolder();
      if (folder) {
        await editorProvider.open(folder);
      }
    })
  );

  // Primary empty-state flow: create a new managed config or adopt an existing launch.json entry.
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.openConfigurationFlow', async () => {
      const folder = await getWorkspaceFolder();
      if (!folder) {
        return;
      }

      const adoptable = configStore.getAdoptableConfigurations();
      if (adoptable.length === 0) {
        await editorProvider.open(folder);
        return;
      }

      const isMultiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
      const selected = await vscode.window.showQuickPick(
        [
          {
            label: '$(add) Create new configuration',
            detail: 'Add a new CharmRun-managed entry to .vscode/launch.json',
            action: 'create' as const,
          },
          ...adoptable.map((item) => ({
            label: `$(cloud-download) Adopt: ${item.config.name}`,
            description: isMultiRoot ? item.folder.name : undefined,
            detail:
              item.config.runType === 'script'
                ? item.config.script
                : `-m ${item.config.module}`,
            action: 'adopt' as const,
            item,
          })),
        ],
        {
          placeHolder: 'Create a new configuration or adopt one from launch.json',
        }
      );

      if (!selected) {
        return;
      }

      if (selected.action === 'create') {
        await editorProvider.open(folder);
        return;
      }

      const adopted = configStore.adoptConfiguration(
        selected.item.folder,
        selected.item.entryIndex
      );
      if (!adopted) {
        vscode.window.showErrorMessage(
          'CharmRun: Failed to adopt the selected launch configuration.'
        );
        return;
      }

      configStore.setActiveConfigId(adopted.id);
      await editorProvider.open(selected.item.folder, adopted);
    })
  );

  // Adopt an existing Python launch.json configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.adoptLaunchConfiguration', async () => {
      const adoptable = configStore.getAdoptableConfigurations();
      if (adoptable.length === 0) {
        vscode.window.showInformationMessage(
          'CharmRun: No unmanaged Python launch configurations found in launch.json.'
        );
        return;
      }

      const isMultiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
      const selected = await vscode.window.showQuickPick(
        adoptable.map((item) => ({
          label: item.config.name,
          description: isMultiRoot ? item.folder.name : undefined,
          detail:
            item.config.runType === 'script'
              ? item.config.script
              : `-m ${item.config.module}`,
          item,
        })),
        {
          placeHolder: 'Select a Python launch configuration to manage with CharmRun',
        }
      );

      if (!selected) {
        return;
      }

      const adopted = configStore.adoptConfiguration(
        selected.item.folder,
        selected.item.entryIndex
      );
      if (!adopted) {
        vscode.window.showErrorMessage(
          'CharmRun: Failed to adopt the selected launch configuration.'
        );
        return;
      }

      configStore.setActiveConfigId(adopted.id);
      await editorProvider.open(selected.item.folder, adopted);
    })
  );

  // Edit configuration (from tree item)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.editConfiguration',
      async (item?: ConfigTreeItem) => {
        if (!item) {
          // Called from command palette - let user pick
          const config = await pickConfiguration(configStore);
          if (config) {
            await editorProvider.open(config.folder, config.config);
          }
          return;
        }
        const folder = findFolderByUri(item.folderUri);
        if (folder) {
          await editorProvider.open(folder, item.config);
        }
      }
    )
  );

  // Delete configuration
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.deleteConfiguration',
      async (item?: ConfigTreeItem) => {
        let targetConfig: { folder: vscode.WorkspaceFolder; config: import('./types').RunConfiguration } | undefined;

        if (item) {
          const folder = findFolderByUri(item.folderUri);
          if (folder) {
            targetConfig = { folder, config: item.config };
          }
        } else {
          targetConfig = await pickConfiguration(configStore);
        }

        if (!targetConfig) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete configuration "${targetConfig.config.name}"?`,
          { modal: true },
          'Delete'
        );
        if (confirm === 'Delete') {
          try {
            configStore.deleteConfiguration(targetConfig.folder, targetConfig.config.id);
          } catch {
            // ConfigStore already showed why
          }
        }
      }
    )
  );

  // Duplicate configuration
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.duplicateConfiguration',
      async (item?: ConfigTreeItem) => {
        // From the Command Palette there is no tree item: ask which configuration, as Edit and Delete do.
        const target = item
          ? { folder: findFolderByUri(item.folderUri), configId: item.config.id }
          : await pickConfiguration(configStore).then((picked) =>
              picked && { folder: picked.folder, configId: picked.config.id }
            );
        if (target?.folder) {
          try {
            configStore.duplicateConfiguration(target.folder, target.configId);
          } catch {
            // ConfigStore already showed why
          }
        }
      }
    )
  );

  // Select active configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.selectActiveConfig', async () => {
      const allConfigs = configStore.getAllConfigurations();
      const items: (vscode.QuickPickItem & { configId?: string })[] = [];

      for (const { folder, configs } of allConfigs) {
        for (const config of configs) {
          const isMultiRoot = (vscode.workspace.workspaceFolders?.length || 0) > 1;
          items.push({
            label: config.name,
            description: isMultiRoot ? folder.name : undefined,
            detail:
              config.runType === 'script'
                ? config.script
                : `-m ${config.module}`,
            configId: config.id,
          });
        }
      }

      if (items.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No run configurations found.',
          'Create Configuration'
        );
        if (action) {
          vscode.commands.executeCommand('charmrun.openConfigurationFlow');
        }
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select active run configuration',
      });

      if (selected?.configId) {
        configStore.setActiveConfigId(selected.configId);
        statusBar.update();
      }
    })
  );

  // Refresh configurations
  context.subscriptions.push(
    vscode.commands.registerCommand('charmrun.refreshConfigurations', () => {
      treeProvider.refresh();
      statusBar.update();
    })
  );

  // Tree item click. VS Code has no double-click event for tree views, so the
  // item's command fires on every click and the gap between two clicks on the
  // same item is measured here. When the user has set
  // workbench.list.openMode to doubleClick, VS Code already withholds the
  // command until the second click, so the first one opens the editor.
  let lastActivation: { id: string; at: number } | undefined;
  const DOUBLE_CLICK_MS = 500;

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.treeItemActivated',
      async (item: ConfigTreeItem) => {
        const openMode = vscode.workspace
          .getConfiguration('workbench.list')
          .get<string>('openMode');
        const now = Date.now();
        const isSecondClick =
          lastActivation?.id === item.config.id &&
          now - lastActivation.at < DOUBLE_CLICK_MS;

        if (openMode !== 'doubleClick' && !isSecondClick) {
          lastActivation = { id: item.config.id, at: now };
          return;
        }

        lastActivation = undefined;
        const folder = findFolderByUri(item.folderUri);
        if (folder) {
          await editorProvider.open(folder, item.config);
        }
      }
    )
  );

  // Run from tree (inline button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.runConfigFromTree',
      async (item: ConfigTreeItem) => {
        const folder = findFolderByUri(item.folderUri);
        if (folder) {
          await runner.execute(item.config, folder, 'run');
        }
      }
    )
  );

  // Debug from tree (inline button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'charmrun.debugConfigFromTree',
      async (item: ConfigTreeItem) => {
        const folder = findFolderByUri(item.folderUri);
        if (folder) {
          await runner.execute(item.config, folder, 'debug');
        }
      }
    )
  );
}

async function getWorkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('CharmRun: No workspace folder open.');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: 'Select workspace folder',
  });
}

async function getWorkspaceFolderForActiveEditor(): Promise<vscode.WorkspaceFolder | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) {
      return folder;
    }
  }

  return getWorkspaceFolder();
}

function findFolderByUri(uri: string): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.toString() === uri
  );
}

async function pickConfiguration(
  configStore: ConfigStore
): Promise<{ folder: vscode.WorkspaceFolder; config: import('./types').RunConfiguration } | undefined> {
  const allConfigs = configStore.getAllConfigurations();
  const items: (vscode.QuickPickItem & {
    folder: vscode.WorkspaceFolder;
    configId: string;
  })[] = [];

  for (const { folder, configs } of allConfigs) {
    for (const config of configs) {
      items.push({
        label: config.name,
        folder,
        configId: config.id,
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No configurations found.');
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select configuration',
  });

  if (selected) {
    const found = configStore.findConfigById(selected.configId);
    if (found) {
      return found;
    }
  }
  return undefined;
}
