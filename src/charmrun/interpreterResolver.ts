import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';

export class InterpreterResolver {
  async resolve(
    interpreter: string,
    folder: vscode.WorkspaceFolder
  ): Promise<string | undefined> {
    if (interpreter !== 'selected') {
      const problem = await this.check(interpreter);
      if (!problem) {
        return interpreter;
      }
      vscode.window.showErrorMessage(
        `CharmRun: Interpreter "${interpreter}" ${problem}. Fix the Python interpreter in the run configuration.`
      );
      return undefined;
    }

    // Try the Python extension's interpreter
    let pythonPath: string | undefined;
    try {
      pythonPath = await vscode.commands.executeCommand<string>(
        'python.interpreterPath',
        { workspaceFolder: folder.uri.toString() }
      );
    } catch {
      // Python extension not available
    }
    if (pythonPath) {
      const problem = await this.check(pythonPath);
      if (!problem) {
        return pythonPath;
      }
      // An explicit path chosen by the user must not be silently swapped for
      // another interpreter; bare commands are just the extension's default.
      if (isExplicitPath(pythonPath)) {
        this.reportSelectedInterpreter(pythonPath, problem);
        return undefined;
      }
    }

    // Fallback: read from python config
    const config = vscode.workspace.getConfiguration('python', folder);
    const defaultPath = config.get<string>('defaultInterpreterPath');
    if (defaultPath) {
      const problem = await this.check(defaultPath);
      if (!problem) {
        return defaultPath;
      }
      if (isExplicitPath(defaultPath)) {
        vscode.window.showErrorMessage(
          `CharmRun: python.defaultInterpreterPath "${defaultPath}" ${problem}.`
        );
        return undefined;
      }
    }

    // Fallback: try system python
    for (const cmd of ['python3', 'python']) {
      if (!(await this.check(cmd))) {
        return cmd;
      }
    }

    vscode.window.showErrorMessage(
      'CharmRun: No Python interpreter found. Install the Python extension or specify a custom interpreter path.'
    );
    return undefined;
  }

  /**
   * Runs `<interpreter> --version` and returns why the interpreter is unusable,
   * or undefined when it is a working Python.
   */
  async check(interpreterPath: string): Promise<string | undefined> {
    if (isExplicitPath(interpreterPath)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(interpreterPath);
      } catch {
        return 'does not exist';
      }
      if (stat.isDirectory()) {
        return 'is a directory, not a Python executable';
      }
    }

    return new Promise((resolve) => {
      const onExit = (
        error: Error | null,
        stdout: string,
        stderr: string
      ): void => {
        const output = `${stdout}${stderr}`.trim();
        if (error) {
          resolve(
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'was not found'
              : `could not be run (${output || error.message})`
          );
        } else if (!/^Python \d/i.test(output)) {
          resolve(
            `does not look like a Python interpreter (\`--version\` printed "${truncate(output) || 'nothing'}")`
          );
        } else {
          resolve(undefined);
        }
      };

      try {
        execFile(
          interpreterPath,
          ['--version'],
          { encoding: 'utf-8', timeout: 5000 },
          onExit
        );
      } catch (error) {
        // execFile throws synchronously for some spawn failures (e.g. ENOEXEC).
        onExit(error instanceof Error ? error : new Error(String(error)), '', '');
      }
    });
  }

  private reportSelectedInterpreter(pythonPath: string, problem: string): void {
    const selectAction = 'Select Interpreter';
    void vscode.window
      .showErrorMessage(
        `CharmRun: The interpreter selected in the Python extension, "${pythonPath}", ${problem}.`,
        selectAction
      )
      .then((choice) => {
        if (choice === selectAction) {
          void vscode.commands.executeCommand('python.setInterpreter');
        }
      });
  }
}

function isExplicitPath(interpreterPath: string): boolean {
  return interpreterPath.includes('/') || interpreterPath.includes('\\');
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
