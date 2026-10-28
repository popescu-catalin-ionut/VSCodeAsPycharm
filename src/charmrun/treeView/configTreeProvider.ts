import * as vscode from 'vscode';
import { ConfigStore } from '../configStore';
import { ConfigTreeItem } from './configTreeItem';

export class ConfigTreeProvider implements vscode.TreeDataProvider<ConfigTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConfigTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private configStore: ConfigStore
  ) {
    configStore.onDidChange(() => this.refresh());
  }

  getTreeItem(element: ConfigTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ConfigTreeItem): ConfigTreeItem[] {
    if (element) {
      return [];
    }

    const activeId = this.configStore.getActiveConfigId();
    const items: ConfigTreeItem[] = [];

    for (const { folder, configs } of this.configStore.getAllConfigurations()) {
      for (const config of configs) {
        items.push(
          new ConfigTreeItem(config, folder.uri.toString(), config.id === activeId)
        );
      }
    }

    return items;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
