import * as vscode from 'vscode';
import { ConfigStore } from './configStore';

export class StatusBarManager implements vscode.Disposable {
  private configSelector: vscode.StatusBarItem;
  private runButton: vscode.StatusBarItem;
  private debugButton: vscode.StatusBarItem;

  constructor(private configStore: ConfigStore) {
    this.configSelector = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.configSelector.command = 'charmrun.selectActiveConfig';
    this.configSelector.tooltip = 'Select Run Configuration';

    this.runButton = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      99
    );
    this.runButton.text = '$(play)';
    this.runButton.command = 'charmrun.runConfiguration';
    this.runButton.tooltip = 'Run Active Configuration';

    this.debugButton = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      98
    );
    this.debugButton.text = '$(bug)';
    this.debugButton.command = 'charmrun.debugConfiguration';
    this.debugButton.tooltip = 'Debug Active Configuration';

    this.configStore.onDidChange(() => this.update());
  }

  update(): void {
    const activeId = this.configStore.getActiveConfigId();
    if (activeId) {
      const found = this.configStore.findConfigById(activeId);
      if (found) {
        this.configSelector.text = `$(gear) ${found.config.name}`;
        this.configSelector.command = 'charmrun.selectActiveConfig';
        this.runButton.show();
        this.debugButton.show();
        return;
      }
    }

    // Check if any configs exist
    const allConfigs = this.configStore.getAllConfigurations();
    const hasConfigs = allConfigs.some((g) => g.configs.length > 0);

    if (hasConfigs) {
      this.configSelector.text = '$(gear) Select Config';
      this.configSelector.command = 'charmrun.selectActiveConfig';
    } else {
      this.configSelector.text = '$(add) Add Run Config';
      this.configSelector.command = 'charmrun.openConfigurationFlow';
    }

    this.runButton.hide();
    this.debugButton.hide();
  }

  show(): void {
    this.configSelector.show();
    this.update();
  }

  hide(): void {
    this.configSelector.hide();
    this.runButton.hide();
    this.debugButton.hide();
  }

  dispose(): void {
    this.configSelector.dispose();
    this.runButton.dispose();
    this.debugButton.dispose();
  }
}
