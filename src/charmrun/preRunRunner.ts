import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PreRunStep, describePreRunStep } from './types';
import { VariableResolver } from './variableResolver';

/**
 * Runs one referenced CharmRun configuration to completion.
 * Returns false when the configuration could not be started.
 * `chain` carries the configuration ids already on the launch stack so
 * cycles can be rejected instead of recursing forever.
 */
export type ConfigStepExecutor = (
  configId: string,
  folder: vscode.WorkspaceFolder,
  chain: Set<string>
) => Promise<boolean>;

export type ConfigNameLookup = (configId: string) => string | undefined;

export class PreRunRunner {
  constructor(
    private output: vscode.OutputChannel,
    private executeConfig: ConfigStepExecutor,
    private lookupConfigName: ConfigNameLookup
  ) {}

  /**
   * Executes the enabled steps in order. Resolves to false as soon as a step
   * fails or the user cancels, so the caller can skip the main launch.
   */
  async run(
    steps: PreRunStep[],
    folder: vscode.WorkspaceFolder,
    chain: Set<string>
  ): Promise<boolean> {
    const enabled = steps.filter((step) => step.enabled);
    if (enabled.length === 0) {
      return true;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'PyCharm-style Run: before launch',
        cancellable: true,
      },
      async (progress, token) => {
        for (let index = 0; index < enabled.length; index++) {
          const step = enabled[index];
          const label = describePreRunStep(
            step,
            step.type === 'configuration'
              ? this.lookupConfigName(step.configId)
              : undefined
          );

          if (token.isCancellationRequested) {
            this.fail(`Cancelled before "${label}"`);
            return false;
          }

          progress.report({
            message: `${index + 1}/${enabled.length}: ${label}`,
          });
          this.output.appendLine(`[before launch] ${label}`);

          const error = await this.runStep(step, folder, chain, token);
          if (error) {
            this.fail(`${label} failed: ${error}`);
            return false;
          }
        }

        return true;
      }
    );
  }

  /** Returns undefined on success, or a human-readable failure reason. */
  private async runStep(
    step: PreRunStep,
    folder: vscode.WorkspaceFolder,
    chain: Set<string>,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    switch (step.type) {
      case 'configuration':
        return this.runConfigurationStep(step, folder, chain);
      case 'task':
        return this.runTaskStep(step, folder, token);
      default:
        return this.runExternalToolStep(step, folder, token);
    }
  }

  private async runConfigurationStep(
    step: PreRunStep,
    folder: vscode.WorkspaceFolder,
    chain: Set<string>
  ): Promise<string | undefined> {
    if (!step.configId.trim()) {
      return 'no configuration selected';
    }

    if (chain.has(step.configId)) {
      return 'circular before-launch reference';
    }

    const started = await this.executeConfig(step.configId, folder, chain);
    return started ? undefined : 'configuration did not run';
  }

  private async runTaskStep(
    step: PreRunStep,
    folder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const label = step.task.trim();
    if (!label) {
      return 'no task selected';
    }

    let tasks: vscode.Task[];
    try {
      tasks = await vscode.tasks.fetchTasks();
    } catch (error) {
      return `could not read tasks (${describeError(error)})`;
    }

    const task = findTask(tasks, label, folder);
    if (!task) {
      return `task not found`;
    }

    let execution: vscode.TaskExecution;
    try {
      execution = await vscode.tasks.executeTask(task);
    } catch (error) {
      return describeError(error);
    }

    return new Promise<string | undefined>((resolve) => {
      const disposables: vscode.Disposable[] = [];
      const settle = (result: string | undefined) => {
        disposables.forEach((d) => d.dispose());
        resolve(result);
      };

      disposables.push(
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (event.execution !== execution) {
            return;
          }
          settle(
            event.exitCode === undefined || event.exitCode === 0
              ? undefined
              : `exit code ${event.exitCode}`
          );
        }),
        // Tasks without a process (e.g. custom executions) only fire onDidEndTask.
        vscode.tasks.onDidEndTask((event) => {
          if (event.execution === execution) {
            settle(undefined);
          }
        }),
        token.onCancellationRequested(() => {
          execution.terminate();
          settle('cancelled');
        })
      );
    });
  }

  private async runExternalToolStep(
    step: PreRunStep,
    folder: vscode.WorkspaceFolder,
    token: vscode.CancellationToken
  ): Promise<string | undefined> {
    const command = step.command.trim();
    if (!command) {
      return 'no command configured';
    }

    const resolver = new VariableResolver(folder);
    const resolvedCommand = resolver.resolve(command);
    const resolvedArgs = resolver.resolveArray(step.args);
    const cwd = step.cwd.trim()
      ? resolver.resolve(step.cwd)
      : folder.uri.fsPath;
    const commandLine = [quoteCommand(resolvedCommand, cwd), ...resolvedArgs.map((arg) => quoteArg(arg))].join(' ');

    this.output.appendLine(`  $ ${commandLine}`);
    this.output.appendLine(`  cwd: ${cwd}`);

    return new Promise<string | undefined>((resolve) => {
      const child = spawn(commandLine, {
        cwd,
        env: process.env,
        shell: true,
      });

      const disposables: vscode.Disposable[] = [];
      let settled = false;
      const settle = (result: string | undefined) => {
        if (settled) {
          return;
        }
        settled = true;
        disposables.forEach((d) => d.dispose());
        resolve(result);
      };

      child.stdout?.on('data', (data: Buffer) => this.appendOutput(data));
      child.stderr?.on('data', (data: Buffer) => this.appendOutput(data));

      child.on('error', (error) => settle(describeError(error)));
      child.on('close', (code, signal) => {
        if (signal) {
          settle(`terminated by ${signal}`);
          return;
        }
        settle(code === 0 ? undefined : `exit code ${code ?? 'unknown'}`);
      });

      disposables.push(
        token.onCancellationRequested(() => {
          child.kill();
          settle('cancelled');
        })
      );
    });
  }

  private appendOutput(data: Buffer): void {
    const text = data.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) {
        this.output.appendLine(`  | ${line}`);
      }
    }
  }

  private fail(message: string): void {
    this.output.appendLine(`[before launch] ${message}`);
    void vscode.window.showErrorMessage(`PyCharm-style Run: ${message}`);
  }
}

function findTask(
  tasks: vscode.Task[],
  label: string,
  folder: vscode.WorkspaceFolder
): vscode.Task | undefined {
  const matches = tasks.filter(
    (task) => task.name === label || `${task.source}: ${task.name}` === label
  );
  if (matches.length === 0) {
    return undefined;
  }
  return (
    matches.find((task) => task.scope === folder) ?? matches[0]
  );
}

// The command line goes through a shell (cmd.exe on Windows), so every argument with a space or a shell character
// is quoted; before, only spaces and quotes were, so "a&b" ran "b" as a second command.
export function quoteArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (arg && !/[\s"'&|<>^%!()`$;*?\\[\]{}~#]/.test(arg)) {
    return arg;
  }
  if (platform === 'win32') {
    // Windows argument rules: backslashes are doubled only before a quote or at the end.
    return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// A command that is an existing file is quoted when its path needs it ("C:\Program Files\..." was split at the
// space). Anything else, such as "npm run build", is left as typed.
export function quoteCommand(command: string, cwd: string, platform: NodeJS.Platform = process.platform): string {
  if (/^["']/.test(command) || !/[\s&|<>^()]/.test(command)) {
    return command;
  }
  return fs.existsSync(path.resolve(cwd, command)) ? quoteArg(command, platform) : command;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
