export type RunType = 'script' | 'module';
export type TerminalType = 'integrated' | 'external' | 'internalConsole';
export type RunMode = 'run' | 'debug';
export type PreRunStepType = 'configuration' | 'externalTool' | 'task';

/**
 * A single "before launch" step, PyCharm-style: run another CharmRun
 * configuration, an external tool, or a VS Code task before the main launch.
 */
export interface PreRunStep {
  id: string;
  type: PreRunStepType;
  enabled: boolean;
  /** type === 'configuration': id of another CharmRun-managed configuration */
  configId: string;
  /** type === 'externalTool': executable or command to run */
  command: string;
  /** type === 'externalTool': arguments passed to the command */
  args: string[];
  /** type === 'externalTool': working directory (variables supported) */
  cwd: string;
  /** type === 'task': label of a VS Code task */
  task: string;
}

export interface RunConfiguration {
  id: string;
  name: string;
  runType: RunType;
  script: string;
  module: string;
  interpreter: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  envFile: string;
  terminal: TerminalType;
  runMode: RunMode;
  preRun: PreRunStep[];
  /** Save console output to `outputFile`, overwriting it on every run. */
  saveOutputToFile: boolean;
  outputFile: string;
  extra?: Record<string, unknown>;
}

export function createDefaultConfig(name: string): RunConfiguration {
  return {
    id: generateId(),
    name,
    runType: 'script',
    script: '',
    module: '',
    interpreter: 'selected',
    args: [],
    cwd: '${workspaceFolder}',
    env: {},
    envFile: '',
    terminal: 'integrated',
    runMode: 'run',
    preRun: [],
    saveOutputToFile: false,
    outputFile: '',
    extra: {
      justMyCode: true,
    },
  };
}

export function createPreRunStep(type: PreRunStepType): PreRunStep {
  return {
    id: generateId(),
    type,
    enabled: true,
    configId: '',
    command: '',
    args: [],
    cwd: '${workspaceFolder}',
    task: '',
  };
}

/**
 * Coerce untrusted input (launch.json contents, webview messages) into a
 * well-formed list of pre-run steps. Unknown step types are dropped.
 */
export function normalizePreRunSteps(value: unknown): PreRunStep[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizePreRunStep(entry))
    .filter((step): step is PreRunStep => Boolean(step));
}

function normalizePreRunStep(value: unknown): PreRunStep | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const type = raw.type;
  if (type !== 'configuration' && type !== 'externalTool' && type !== 'task') {
    return undefined;
  }

  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id : generateId(),
    type,
    enabled: raw.enabled !== false,
    configId: typeof raw.configId === 'string' ? raw.configId : '',
    command: typeof raw.command === 'string' ? raw.command : '',
    args: Array.isArray(raw.args) ? raw.args.map((arg) => String(arg)) : [],
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    task: typeof raw.task === 'string' ? raw.task : '',
  };
}

export function clonePreRunSteps(steps: PreRunStep[]): PreRunStep[] {
  return steps.map((step) => ({ ...step, args: [...step.args] }));
}

export function describePreRunStep(
  step: PreRunStep,
  configName?: string
): string {
  switch (step.type) {
    case 'configuration':
      return `Run configuration "${configName ?? step.configId}"`;
    case 'task':
      return `Task "${step.task}"`;
    default:
      return `External tool "${[step.command, ...step.args].join(' ').trim()}"`;
  }
}

export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
