import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { applyEdits, modify, parse, ParseError, type FormattingOptions } from 'jsonc-parser';
import { pinToWorkspace, unpinFromWorkspace } from './launchPaths';
import {
  RunConfiguration,
  clonePreRunSteps,
  generateId,
  normalizePreRunSteps,
} from './types';

const CONFIG_FILENAME = 'launch.json';
const ACTIVE_CONFIG_KEY = 'charmrun.activeConfigId';
const CHARMRUN_MANAGED_KEY = 'charmrunManaged';
const CHARMRUN_ID_KEY = 'charmrunId';
const CHARMRUN_RUN_MODE_KEY = 'charmrunRunMode';
const CHARMRUN_PRE_RUN_KEY = 'charmrunPreRun';
const CHARMRUN_SAVE_OUTPUT_KEY = 'charmrunSaveOutput';
const CHARMRUN_OUTPUT_FILE_KEY = 'charmrunOutputFile';

type LaunchJsonFile = {
  version: string;
  /** The object entries of "configurations" (non-objects skipped). */
  configurations: LaunchConfiguration[];
  /** For each entry above, its index in the real "configurations" array of the file. */
  rawIndexes: number[];
  /** The file text, or undefined when there is no launch.json yet. */
  text?: string;
  /** The file exists but could not be parsed: it must not be written over. */
  broken?: boolean;
};

// launch.json is JSON with comments and trailing commas, as VS Code reads it.
const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

type LaunchConfiguration = Record<string, unknown> & {
  name?: string;
  type?: string;
  request?: string;
  program?: string;
  module?: string;
  python?: string;
  args?: unknown;
  cwd?: string;
  env?: Record<string, unknown>;
  envFile?: string;
  console?: string;
  noDebug?: boolean;
  charmrunManaged?: boolean;
  charmrunId?: string;
  charmrunRunMode?: string;
  charmrunPreRun?: unknown;
  charmrunSaveOutput?: boolean;
  charmrunOutputFile?: string;
};

export type AdoptableConfiguration = {
  folder: vscode.WorkspaceFolder;
  config: RunConfiguration;
  entryIndex: number;
};

const KNOWN_DEBUG_KEYS = new Set([
  'name',
  'type',
  'request',
  'program',
  'module',
  'python',
  'args',
  'cwd',
  'env',
  'envFile',
  'console',
  'noDebug',
  CHARMRUN_MANAGED_KEY,
  CHARMRUN_ID_KEY,
  CHARMRUN_RUN_MODE_KEY,
  CHARMRUN_PRE_RUN_KEY,
  CHARMRUN_SAVE_OUTPUT_KEY,
  CHARMRUN_OUTPUT_FILE_KEY,
]);

export class ConfigStore implements vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private context: vscode.ExtensionContext;
  /** launch.json path -> the broken text last warned about. */
  private warnedBroken = new Map<string, string | undefined>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.setupFileWatchers();
  }

  private getConfigPath(folder: vscode.WorkspaceFolder): string {
    return path.join(folder.uri.fsPath, '.vscode', CONFIG_FILENAME);
  }

  getConfigurations(folder: vscode.WorkspaceFolder): RunConfiguration[] {
    return this.readLaunchFile(folder).configurations
      .map((entry) => this.toManagedRunConfiguration(entry))
      .filter((config): config is RunConfiguration => Boolean(config));
  }

  getAllConfigurations(): { folder: vscode.WorkspaceFolder; configs: RunConfiguration[] }[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map((folder) => ({
      folder,
      configs: this.getConfigurations(folder),
    }));
  }

  private saveConfigurations(
    folder: vscode.WorkspaceFolder,
    configs: RunConfiguration[]
  ): void {
    // Edits only CharmRun's own entries, in place, so the user's other entries and comments stay as they are.
    // The file's managed entries, in order, by id. An id can repeat when an entry was copied by hand; the n-th
    // config with that id is then written back to the n-th entry with it.
    const launchFile = this.readLaunchFile(folder);
    const slots = new Map<string, number[]>();
    launchFile.configurations.forEach((entry, i) => {
      if (this.isCharmRunManaged(entry)) {
        const id = entry[CHARMRUN_ID_KEY] as string;
        slots.set(id, [...(slots.get(id) ?? []), launchFile.rawIndexes[i]]);
      }
    });

    let text = this.startText(launchFile);
    const added: RunConfiguration[] = [];
    for (const config of configs) {
      const index = slots.get(config.id)?.shift();
      if (index === undefined) {
        added.push(config);
      } else {
        text = this.edit(text, ['configurations', index], this.toLaunchConfiguration(config));
      }
    }
    const removed = [...slots.values()].flat(); // entries no config was written to
    for (const index of removed.sort((a, b) => b - a)) {
      text = this.edit(text, ['configurations', index], undefined);
    }
    for (const config of added) {
      text = this.edit(text, ['configurations', this.countEntries(text)], this.toLaunchConfiguration(config), true);
    }

    this.writeLaunchText(folder, text);
    this._onDidChange.fire();
  }

  addConfiguration(
    folder: vscode.WorkspaceFolder,
    config: RunConfiguration
  ): void {
    const configs = this.getConfigurations(folder);
    configs.push(config);
    this.saveConfigurations(folder, configs);
  }

  updateConfiguration(
    folder: vscode.WorkspaceFolder,
    config: RunConfiguration
  ): void {
    const configs = this.getConfigurations(folder);
    const index = configs.findIndex((c) => c.id === config.id);
    if (index >= 0) {
      configs[index] = config;
    } else {
      // Deleted meanwhile (another window, a hand edit): saving the form adds it back instead of losing it.
      configs.push(config);
    }
    this.saveConfigurations(folder, configs);
  }

  deleteConfiguration(
    folder: vscode.WorkspaceFolder,
    configId: string
  ): void {
    const configs = this.getConfigurations(folder);
    const filtered = configs.filter((c) => c.id !== configId);
    this.saveConfigurations(folder, filtered);

    if (this.getActiveConfigId() === configId) {
      this.setActiveConfigId(undefined);
    }
  }

  duplicateConfiguration(
    folder: vscode.WorkspaceFolder,
    configId: string
  ): RunConfiguration | undefined {
    const configs = this.getConfigurations(folder);
    const source = configs.find((c) => c.id === configId);
    if (!source) {
      return undefined;
    }

    const copy: RunConfiguration = {
      ...source,
      id: generateId(),
      name: `${source.name} (Copy)`,
      args: [...source.args],
      env: { ...source.env },
      preRun: clonePreRunSteps(source.preRun),
      extra: { ...(source.extra ?? {}) },
    };
    configs.push(copy);
    this.saveConfigurations(folder, configs);
    return copy;
  }

  getAdoptableConfigurations(): AdoptableConfiguration[] {
    const folders = vscode.workspace.workspaceFolders || [];
    const adoptable: AdoptableConfiguration[] = [];

    for (const folder of folders) {
      const launchFile = this.readLaunchFile(folder);
      launchFile.configurations.forEach((entry, i) => {
        const index = launchFile.rawIndexes[i];
        if (!this.isAdoptable(entry)) {
          return;
        }

        const config = this.toRunConfiguration(entry, `adopt:${folder.index}:${index}`);
        if (!config) {
          return;
        }

        adoptable.push({
          folder,
          config,
          entryIndex: index,
        });
      });
    }

    return adoptable;
  }

  adoptConfiguration(
    folder: vscode.WorkspaceFolder,
    entryIndex: number
  ): RunConfiguration | undefined {
    // entryIndex is the index in the file's "configurations" array.
    const launchFile = this.readLaunchFile(folder);
    const entry = launchFile.configurations[launchFile.rawIndexes.indexOf(entryIndex)];
    if (!entry || !this.isAdoptable(entry)) {
      return undefined;
    }

    const adopted = this.toRunConfiguration(entry, generateId());
    if (!adopted) {
      return undefined;
    }

    try {
      const text = this.edit(this.startText(launchFile), ['configurations', entryIndex], this.toLaunchConfiguration(adopted));
      this.writeLaunchText(folder, text);
    } catch {
      return undefined; // already shown to the user
    }
    this._onDidChange.fire();
    return adopted;
  }

  findConfigById(configId: string): {
    folder: vscode.WorkspaceFolder;
    config: RunConfiguration;
  } | undefined {
    for (const { folder, configs } of this.getAllConfigurations()) {
      const config = configs.find((c) => c.id === configId);
      if (config) {
        return { folder, config };
      }
    }
    return undefined;
  }

  findConfigFolder(configId: string): vscode.WorkspaceFolder | undefined {
    return this.findConfigById(configId)?.folder;
  }

  getActiveConfigId(): string | undefined {
    return this.context.workspaceState.get<string>(ACTIVE_CONFIG_KEY);
  }

  setActiveConfigId(configId: string | undefined): void {
    this.context.workspaceState.update(ACTIVE_CONFIG_KEY, configId);
    this._onDidChange.fire();
  }

  private setupFileWatchers(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      `**/.vscode/${CONFIG_FILENAME}`
    );
    watcher.onDidChange(() => this._onDidChange.fire());
    watcher.onDidCreate(() => this._onDidChange.fire());
    watcher.onDidDelete(() => this._onDidChange.fire());
    this.fileWatchers.push(watcher);
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.fileWatchers.forEach((w) => w.dispose());
  }

  private readLaunchFile(folder: vscode.WorkspaceFolder): LaunchJsonFile {
    const configPath = this.getConfigPath(folder);
    if (!fs.existsSync(configPath)) {
      return { version: '0.2.0', configurations: [], rawIndexes: [] };
    }

    let text: string | undefined;
    try {
      text = fs.readFileSync(configPath, 'utf-8');
      const errors: ParseError[] = [];
      const parsed = parse(text, errors, PARSE_OPTIONS) as
        | { version?: unknown; configurations?: unknown }
        | undefined;

      if (errors.length > 0 || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Invalid launch.json');
      }

      const configurations: LaunchConfiguration[] = [];
      const rawIndexes: number[] = [];
      (Array.isArray(parsed.configurations) ? parsed.configurations : []).forEach((entry: unknown, index: number) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          configurations.push(entry as LaunchConfiguration);
          rawIndexes.push(index);
        }
      });

      return {
        version: typeof parsed.version === 'string' ? parsed.version : '0.2.0',
        configurations,
        rawIndexes,
        text,
      };
    } catch {
      // The sidebar and the status bar both re-read the file on every change: warn once per broken content.
      if (this.warnedBroken.get(configPath) !== text) {
        this.warnedBroken.set(configPath, text);
        vscode.window.showWarningMessage(
          `PyCharm-style Run: Failed to read launch config: ${configPath}`
        );
      }
      return { version: '0.2.0', configurations: [], rawIndexes: [], text, broken: true };
    }
  }

  /** The text to edit: the file as it is, or a new launch.json. Refuses a file that could not be parsed. */
  private startText(launchFile: LaunchJsonFile): string {
    if (launchFile.broken) {
      throw this.fail('launch.json has a syntax error. Fix it first; PyCharm-style Run will not overwrite it.');
    }
    let text = launchFile.text ?? '{\n  "version": "0.2.0",\n  "configurations": []\n}\n';
    const root = parse(text, [], PARSE_OPTIONS) as { configurations?: unknown };
    if (!Array.isArray(root.configurations)) {
      text = this.edit(text, ['configurations'], []);
    }
    return text;
  }

  private countEntries(text: string): number {
    const root = parse(text, [], PARSE_OPTIONS) as { configurations?: unknown[] };
    return root.configurations?.length ?? 0;
  }

  /** One jsonc-parser edit, keeping the file's indentation and line endings. */
  private edit(text: string, jsonPath: (string | number)[], value: unknown, insert = false): string {
    const formattingOptions: FormattingOptions = {
      insertSpaces: !/^\t/m.test(text),
      tabSize: 2,
      eol: text.includes('\r\n') ? '\r\n' : '\n',
    };
    return applyEdits(text, modify(text, jsonPath, value, { formattingOptions, isArrayInsertion: insert }));
  }

  /** Shows the problem and returns an error for the caller to throw. */
  private fail(message: string): Error {
    void vscode.window.showErrorMessage(`PyCharm-style Run: ${message}`);
    return new Error(message);
  }

  private writeLaunchText(folder: vscode.WorkspaceFolder, text: string): void {
    const errors: ParseError[] = [];
    parse(text, errors, PARSE_OPTIONS);
    if (errors.length > 0) {
      throw this.fail('Could not update launch.json without breaking it; nothing was written.');
    }
    const configPath = this.getConfigPath(folder);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, text, 'utf-8');
  }

  private isPythonLaunchConfig(entry: LaunchConfiguration): boolean {
    return entry.type === 'debugpy' && entry.request === 'launch';
  }

  private isCharmRunManaged(entry: LaunchConfiguration): boolean {
    return entry[CHARMRUN_MANAGED_KEY] === true
      && typeof entry[CHARMRUN_ID_KEY] === 'string'
      && entry[CHARMRUN_ID_KEY].trim().length > 0;
  }

  private isAdoptable(entry: LaunchConfiguration): boolean {
    return this.isPythonLaunchConfig(entry) && !this.isCharmRunManaged(entry);
  }

  private toManagedRunConfiguration(
    entry: LaunchConfiguration
  ): RunConfiguration | undefined {
    if (!this.isCharmRunManaged(entry)) {
      return undefined;
    }

    return this.toRunConfiguration(entry, entry[CHARMRUN_ID_KEY]);
  }

  private toRunConfiguration(
    entry: LaunchConfiguration,
    id: unknown
  ): RunConfiguration | undefined {
    if (!this.isPythonLaunchConfig(entry) || typeof id !== 'string' || !id.trim()) {
      return undefined;
    }

    const program = typeof entry.program === 'string' ? entry.program : '';
    const moduleName = typeof entry.module === 'string' ? entry.module : '';
    const runType = moduleName.trim() ? 'module' : 'script';
    const args = Array.isArray(entry.args)
      ? entry.args.map((value) => String(value))
      : [];
    const envObject = entry.env && typeof entry.env === 'object'
      ? entry.env
      : {};
    const env = Object.fromEntries(
      Object.entries(envObject)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)])
    );

    return {
      id,
      name: typeof entry.name === 'string' && entry.name.trim()
        ? entry.name
        : 'Unnamed Configuration',
      runType,
      script: runType === 'script' ? unpinFromWorkspace(program) : '',
      module: runType === 'module' ? moduleName : '',
      interpreter: typeof entry.python === 'string' && entry.python.trim()
        ? entry.python
        : 'selected',
      args,
      cwd: typeof entry.cwd === 'string' && entry.cwd.trim()
        ? entry.cwd
        : '${workspaceFolder}',
      env,
      envFile: typeof entry.envFile === 'string' ? unpinFromWorkspace(entry.envFile) : '',
      terminal: this.fromLaunchConsole(entry.console),
      runMode: this.fromLaunchRunMode(entry),
      preRun: normalizePreRunSteps(entry[CHARMRUN_PRE_RUN_KEY]),
      saveOutputToFile: entry[CHARMRUN_SAVE_OUTPUT_KEY] === true,
      outputFile: typeof entry[CHARMRUN_OUTPUT_FILE_KEY] === 'string'
        ? entry[CHARMRUN_OUTPUT_FILE_KEY]
        : '',
      extra: this.extractExtraFields(entry),
    };
  }

  private toLaunchConfiguration(config: RunConfiguration): LaunchConfiguration {
    const launchConfig: LaunchConfiguration = {
      ...(config.extra ?? {}),
      name: config.name,
      type: 'debugpy',
      request: 'launch',
      args: [...config.args],
      cwd: config.cwd,
      env: { ...config.env },
      console: this.toLaunchConsole(config.terminal),
      justMyCode: (config.extra?.justMyCode as boolean | undefined) ?? true,
      [CHARMRUN_MANAGED_KEY]: true,
      [CHARMRUN_ID_KEY]: config.id,
      [CHARMRUN_RUN_MODE_KEY]: config.runMode,
    };

    // Relative paths are saved with ${workspaceFolder}/ so VS Code's own launcher finds them too (launchPaths.ts).
    if (config.runType === 'script') {
      launchConfig.program = pinToWorkspace(config.script);
    } else {
      launchConfig.module = config.module;
    }

    if (config.interpreter !== 'selected') {
      launchConfig.python = config.interpreter;
    }

    if (config.envFile && config.envFile.trim()) {
      launchConfig.envFile = pinToWorkspace(config.envFile);
    }

    if (config.preRun.length > 0) {
      launchConfig[CHARMRUN_PRE_RUN_KEY] = clonePreRunSteps(config.preRun);
    } else {
      delete launchConfig[CHARMRUN_PRE_RUN_KEY];
    }

    if (config.saveOutputToFile && config.outputFile.trim()) {
      launchConfig[CHARMRUN_SAVE_OUTPUT_KEY] = true;
      launchConfig[CHARMRUN_OUTPUT_FILE_KEY] = config.outputFile;
    } else {
      delete launchConfig[CHARMRUN_SAVE_OUTPUT_KEY];
      delete launchConfig[CHARMRUN_OUTPUT_FILE_KEY];
    }

    return launchConfig;
  }

  private fromLaunchConsole(value: unknown): RunConfiguration['terminal'] {
    switch (value) {
      case 'externalTerminal':
        return 'external';
      case 'internalConsole':
        return 'internalConsole';
      default:
        return 'integrated';
    }
  }

  private toLaunchConsole(value: RunConfiguration['terminal']): string {
    switch (value) {
      case 'external':
        return 'externalTerminal';
      case 'internalConsole':
        return 'internalConsole';
      default:
        return 'integratedTerminal';
    }
  }

  private fromLaunchRunMode(entry: LaunchConfiguration): RunConfiguration['runMode'] {
    if (entry[CHARMRUN_RUN_MODE_KEY] === 'run' || entry.noDebug === true) {
      return 'run';
    }
    return 'debug';
  }

  private extractExtraFields(
    entry: LaunchConfiguration
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(entry).filter(([key]) => !KNOWN_DEBUG_KEYS.has(key))
    );
  }
}
