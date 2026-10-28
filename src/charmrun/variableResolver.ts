import * as vscode from 'vscode';
import * as path from 'path';

export class VariableResolver {
  constructor(private folder: vscode.WorkspaceFolder) {}

  resolve(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, variable: string) => {
      return this.resolveVariable(variable) ?? _match;
    });
  }

  resolveArray(values: string[]): string[] {
    return values.map((v) => this.resolve(v));
  }

  resolveRecord(record: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      result[key] = this.resolve(value);
    }
    return result;
  }

  private resolveVariable(variable: string): string | undefined {
    const editor = vscode.window.activeTextEditor;
    const filePath = editor?.document.uri.fsPath;

    switch (variable) {
      case 'workspaceFolder':
        return this.folder.uri.fsPath;
      case 'workspaceFolderBasename':
        return path.basename(this.folder.uri.fsPath);
      case 'file':
        return filePath;
      case 'fileBasename':
        return filePath ? path.basename(filePath) : undefined;
      case 'fileBasenameNoExtension':
        return filePath
          ? path.basename(filePath, path.extname(filePath))
          : undefined;
      case 'fileDirname':
        return filePath ? path.dirname(filePath) : undefined;
      case 'fileExtname':
        return filePath ? path.extname(filePath) : undefined;
      case 'relativeFile':
        return filePath
          ? path.relative(this.folder.uri.fsPath, filePath)
          : undefined;
      default: {
        const envMatch = variable.match(/^env:(.+)$/);
        if (envMatch) {
          return process.env[envMatch[1]] ?? '';
        }
        return undefined;
      }
    }
  }
}
