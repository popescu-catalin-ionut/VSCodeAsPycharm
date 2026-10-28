import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RunConfiguration, RunMode, generateId } from './types';
import { VariableResolver } from './variableResolver';
import { InterpreterResolver } from './interpreterResolver';
import { ConfigStore } from './configStore';
import { PreRunRunner } from './preRunRunner';
import {
  LAUNCH_TOKEN_KEY,
  MANAGED_KEY,
  OUTPUT_FILE_KEY,
  RUN_ID_KEY,
  SessionMonitor,
  beforeLaunchSucceeded,
  describeError,
} from './sessionMonitor';

const DEBUGPY_EXTENSION_ID = 'ms-python.debugpy';

const TERMINAL_MAP: Record<string, string> = {
  integrated: 'integratedTerminal',
  external: 'externalTerminal',
  internalConsole: 'internalConsole',
};

export interface ExecuteOptions {
  /** Configuration ids already on the launch stack, used for cycle detection. */
  chain?: Set<string>;
  /** Wait for the debug session to terminate before resolving. */
  waitForExit?: boolean;
}

export class Runner implements vscode.Disposable {
  private interpreterResolver = new InterpreterResolver();
  private output = vscode.window.createOutputChannel('PyCharm-style Run: Before Launch');
  private preRunRunner: PreRunRunner;
  private sessionMonitor: SessionMonitor;

  constructor(
    private configStore: ConfigStore,
    private runOutput: vscode.OutputChannel
  ) {
    this.preRunRunner = new PreRunRunner(
      this.output,
      (configId, folder, chain) => this.executeConfigStep(configId, folder, chain),
      (configId) => this.configStore.findConfigById(configId)?.config.name
    );
    this.sessionMonitor = new SessionMonitor(runOutput);
  }

  /** Recent launches by run id (newest last), for Rerun. */
  private launches = new Map<string, { config: RunConfiguration; folder: vscode.WorkspaceFolder; mode: RunMode }>();

  private remember(runId: string, launch: { config: RunConfiguration; folder: vscode.WorkspaceFolder; mode: RunMode }): void {
    this.launches.set(runId, launch);
    while (this.launches.size > 50) {
      this.launches.delete(this.launches.keys().next().value!);
    }
  }

  /**
   * Rerun as PyCharm does: the same configuration (as it was launched, also a temporary one), in the same mode,
   * through the before-launch steps again, with the script path resolved the same way. False when the run is
   * not known (e.g. launched before VS Code restarted), so the caller can fall back.
   */
  async rerun(runId: string): Promise<boolean> {
    const launch = this.launches.get(runId);
    if (!launch) {
      return false;
    }
    return this.execute(launch.config, launch.folder, launch.mode);
  }

  async execute(
    config: RunConfiguration,
    folder: vscode.WorkspaceFolder,
    modeOverride?: RunMode,
    options: ExecuteOptions = {}
  ): Promise<boolean> {
    try {
      return await this.executeUnchecked(config, folder, modeOverride, options);
    } catch (error) {
      this.runOutput.appendLine(
        `[run] "${config.name}" failed: ${
          error instanceof Error ? error.stack ?? error.message : String(error)
        }`
      );
      vscode.window.showErrorMessage(
        `PyCharm-style Run: Could not run "${config.name}": ${describeError(error)}`
      );
      return false;
    }
  }

  private async executeUnchecked(
    config: RunConfiguration,
    folder: vscode.WorkspaceFolder,
    modeOverride: RunMode | undefined,
    options: ExecuteOptions
  ): Promise<boolean> {
    const errors = this.validate(config);
    if (errors.length > 0) {
      vscode.window.showErrorMessage(
        `PyCharm-style Run: ${errors.join('; ')}`
      );
      return false;
    }

    const chain = options.chain ?? new Set<string>();
    if (chain.has(config.id)) {
      vscode.window.showErrorMessage(
        `PyCharm-style Run: Circular before-launch reference at "${config.name}".`
      );
      return false;
    }

    const nextChain = new Set(chain).add(config.id);
    const preRunOk = await this.preRunRunner.run(
      config.preRun ?? [],
      folder,
      nextChain
    );
    if (!preRunOk) {
      return false;
    }

    const mode = modeOverride ?? config.runMode;
    const debugConfig = await this.buildDebugConfig(config, folder);
    if (!debugConfig) {
      return false;
    }
    const runId = generateId();
    debugConfig[RUN_ID_KEY] = runId;
    this.remember(runId, { config: JSON.parse(JSON.stringify(config)), folder, mode });

    if (!options.waitForExit) {
      return this.startDebugging(folder, debugConfig, mode);
    }

    const token = generateId();
    debugConfig[LAUNCH_TOKEN_KEY] = token;
    const terminated = this.sessionMonitor.waitForExit(token);

    if (!(await this.startDebugging(folder, debugConfig, mode))) {
      terminated.cancel();
      return false;
    }

    // A configuration used as a before-launch step fails the chain when it
    // exits non-zero or its debug session fails.
    const outcome = await terminated.promise;
    if (beforeLaunchSucceeded(outcome)) {
      return true;
    }
    this.output.appendLine(
      `[before launch] "${config.name}" ${
        outcome.exitCode !== undefined
          ? `exited with code ${outcome.exitCode}`
          : `failed: ${outcome.launchError ?? outcome.adapterError}`
      }`
    );
    return false;
  }

  private async startDebugging(
    folder: vscode.WorkspaceFolder,
    debugConfig: vscode.DebugConfiguration,
    mode: RunMode
  ): Promise<boolean> {
    if (!vscode.extensions.getExtension(DEBUGPY_EXTENSION_ID)) {
      const install = 'Install Python Debugger';
      void vscode.window
        .showErrorMessage(
          'PyCharm-style Run: The Python Debugger extension (ms-python.debugpy) is required to run configurations.',
          install
        )
        .then((choice) => {
          if (choice === install) {
            void vscode.commands.executeCommand(
              'workbench.extensions.search',
              DEBUGPY_EXTENSION_ID
            );
          }
        });
      return false;
    }

    debugConfig[MANAGED_KEY] = true;
    const started = await vscode.debug.startDebugging(folder, debugConfig, {
      noDebug: mode === 'run',
    });
    if (!started) {
      this.runOutput.appendLine(
        `[run] VS Code could not start a debug session for "${debugConfig.name}"`
      );
      vscode.window.showErrorMessage(
        `PyCharm-style Run: Could not start "${debugConfig.name}". Check the Debug Console and Output > PyCharm-style Run for details.`
      );
    }
    return started;
  }

  /** Runs a configuration referenced by another config's before-launch step. */
  private async executeConfigStep(
    configId: string,
    folder: vscode.WorkspaceFolder,
    chain: Set<string>
  ): Promise<boolean> {
    const found = this.configStore.findConfigById(configId);
    if (!found) {
      this.output.appendLine(
        `[before launch] Configuration ${configId} no longer exists`
      );
      return false;
    }

    return this.execute(found.config, found.folder, undefined, {
      chain,
      waitForExit: true,
    });
  }

  async runCurrentFile(
    folder: vscode.WorkspaceFolder,
    mode: RunMode
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('PyCharm-style Run: No active editor.');
      return;
    }

    const filePath = editor.document.uri.fsPath;
    if (!filePath.endsWith('.py')) {
      vscode.window.showErrorMessage(
        'PyCharm-style Run: Active file is not a Python file.'
      );
      return;
    }

    const interpreterPath = await this.interpreterResolver.resolve(
      'selected',
      folder
    );
    if (!interpreterPath) {
      return;
    }

    const debugConfig: vscode.DebugConfiguration = {
      name: `Run ${path.basename(filePath)}`,
      type: 'debugpy',
      request: 'launch',
      program: filePath,
      python: interpreterPath,
      cwd: folder.uri.fsPath,
      console: 'integratedTerminal',
      justMyCode: true,
    };

    try {
      await this.startDebugging(folder, debugConfig, mode);
    } catch (error) {
      vscode.window.showErrorMessage(
        `PyCharm-style Run: Could not run ${path.basename(filePath)}: ${describeError(error)}`
      );
    }
  }

  private async buildDebugConfig(
    config: RunConfiguration,
    folder: vscode.WorkspaceFolder
  ): Promise<vscode.DebugConfiguration | undefined> {
    const resolver = new VariableResolver(folder);

    const interpreterPath = await this.interpreterResolver.resolve(
      config.interpreter,
      folder
    );
    if (!interpreterPath) {
      return undefined;
    }

    const debugConfig: vscode.DebugConfiguration = {
      ...(config.extra ?? {}),
      name: config.name,
      type: 'debugpy',
      request: 'launch',
      python: interpreterPath,
      args: resolver.resolveArray(config.args),
      cwd: resolver.resolve(config.cwd),
      env: resolver.resolveRecord(config.env),
      console: TERMINAL_MAP[config.terminal] || 'integratedTerminal',
      justMyCode: (config.extra?.justMyCode as boolean | undefined) ?? true,
    };

    if (config.runType === 'script') {
      const scriptPath = resolver.resolve(config.script);
      debugConfig.program = path.isAbsolute(scriptPath)
        ? scriptPath
        : path.join(folder.uri.fsPath, scriptPath);
    } else {
      debugConfig.module = config.module;
    }

    if (config.envFile && config.envFile.trim()) {
      const envFilePath = resolver.resolve(config.envFile.trim());
      debugConfig.envFile = path.isAbsolute(envFilePath)
        ? envFilePath
        : path.join(folder.uri.fsPath, envFilePath);
    }

    const missing = this.findMissingPaths(debugConfig, folder);
    if (missing) {
      vscode.window.showErrorMessage(`PyCharm-style Run: "${config.name}": ${missing}`);
      return undefined;
    }

    if (config.saveOutputToFile && config.outputFile.trim()) {
      const outputPath = resolver.resolve(config.outputFile.trim());
      const absoluteOutputPath = path.isAbsolute(outputPath)
        ? outputPath
        : path.join(folder.uri.fsPath, outputPath);

      try {
        fs.mkdirSync(path.dirname(absoluteOutputPath), { recursive: true });
        // Overwrite so each run starts with a clean log, PyCharm-style.
        fs.writeFileSync(absoluteOutputPath, '');
      } catch (error) {
        vscode.window.showErrorMessage(
          `PyCharm-style Run: Could not write output file "${absoluteOutputPath}": ${describeError(
            error
          )}`
        );
        return undefined;
      }

      debugConfig.redirectOutput = true;
      debugConfig[OUTPUT_FILE_KEY] = absoluteOutputPath;
    }

    return debugConfig;
  }

  /** Catches paths debugpy would otherwise fail on inside the terminal. */
  private findMissingPaths(
    debugConfig: vscode.DebugConfiguration,
    folder: vscode.WorkspaceFolder
  ): string | undefined {
    // Leave values with variables VS Code resolves later (e.g. ${command:...})
    // to debugpy.
    const check = (value: unknown, exists: (p: string) => boolean) =>
      typeof value !== 'string' ||
      !value ||
      value.includes('${') ||
      exists(path.resolve(folder.uri.fsPath, value));

    if (!check(debugConfig.program, isFile)) {
      return `script not found: ${debugConfig.program}`;
    }
    if (!check(debugConfig.cwd, isDirectory)) {
      return `working directory not found: ${debugConfig.cwd}`;
    }
    if (!check(debugConfig.envFile, isFile)) {
      return `environment file not found: ${debugConfig.envFile}`;
    }
    return undefined;
  }

  private validate(config: RunConfiguration): string[] {
    const errors: string[] = [];

    if (!config.name.trim()) {
      errors.push('Configuration name is required');
    }

    if (config.runType === 'script' && !config.script.trim()) {
      errors.push('Script path is required');
    }

    if (config.runType === 'module' && !config.module.trim()) {
      errors.push('Module name is required');
    }

    return errors;
  }

  dispose(): void {
    this.output.dispose();
    this.sessionMonitor.dispose();
  }
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
