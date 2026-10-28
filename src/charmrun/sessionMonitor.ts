import * as vscode from 'vscode';
import * as fs from 'fs';

/** Marks a debug session as launched by CharmRun. */
export const MANAGED_KEY = 'charmrunManaged';
export const LAUNCH_TOKEN_KEY = 'charmrunLaunchToken';
export const OUTPUT_FILE_KEY = 'charmrunOutputFile';

export interface SessionOutcome {
  /** Exit code reported by debugpy's `exited` event, if any. */
  exitCode?: number;
  /** The user stopped, restarted or disconnected the session. */
  stopped: boolean;
  /** The debug adapter failed to launch the program, crashed, ... */
  adapterError?: string;
  /** debugpy rejected the launch request; VS Code already shows these. */
  launchError?: string;
}

interface SessionState extends SessionOutcome {
  outputFileError?: string;
  /** debugpy sent `exited` or `terminated`: the program is no longer running. */
  ended: boolean;
}

/**
 * Whether a configuration used as a before-launch step succeeded. When the
 * program reported an exit code that alone decides; a debug adapter error is
 * only a failure when the program never got to report one.
 */
export function beforeLaunchSucceeded(outcome: SessionOutcome): boolean {
  if (outcome.exitCode !== undefined) {
    return outcome.exitCode === 0;
  }
  return !outcome.adapterError && !outcome.launchError;
}

/**
 * Watches every debugpy session CharmRun launches so failures inside the
 * session (non-zero exit, debug adapter errors) are reported to the user
 * instead of only showing up, if at all, in a terminal they may not look at.
 */
export class SessionMonitor implements vscode.Disposable {
  private states = new Map<string, SessionState>();
  private waiters = new Map<string, (outcome: SessionOutcome) => void>();
  private disposables: vscode.Disposable[] = [];

  constructor(private output: vscode.OutputChannel) {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('debugpy', {
        createDebugAdapterTracker: (session) => this.createTracker(session),
      }),
      vscode.debug.onDidTerminateDebugSession((session) =>
        this.onTerminate(session)
      )
    );
  }

  /** Resolves once the session launched with `token` terminates. */
  waitForExit(token: string): {
    promise: Promise<SessionOutcome>;
    cancel: () => void;
  } {
    const promise = new Promise<SessionOutcome>((resolve) => {
      this.waiters.set(token, resolve);
    });
    return {
      promise,
      cancel: () => {
        this.waiters.get(token)?.({ stopped: true });
        this.waiters.delete(token);
      },
    };
  }

  private createTracker(
    session: vscode.DebugSession
  ): vscode.DebugAdapterTracker | undefined {
    if (session.configuration[MANAGED_KEY] !== true) {
      return undefined;
    }

    const state: SessionState = { stopped: false, ended: false };
    this.states.set(session.id, state);
    this.output.appendLine(`[run] Starting "${session.name}"`);

    // debugpy only emits DAP 'output' events for a session when
    // `redirectOutput` is set, which buildDebugConfig does whenever a config
    // asks to save its console output.
    const outputFile = session.configuration[OUTPUT_FILE_KEY];
    const appendOutput = (text: string) => {
      if (typeof outputFile !== 'string' || !outputFile || state.outputFileError) {
        return;
      }
      try {
        fs.appendFileSync(outputFile, text);
      } catch (error) {
        state.outputFileError = describeError(error);
        this.output.appendLine(
          `[run] Could not write to output file "${outputFile}": ${state.outputFileError}`
        );
        void vscode.window.showErrorMessage(
          `PyCharm-style Run: Could not write console output to "${outputFile}": ${state.outputFileError}`
        );
      }
    };

    return {
      onWillReceiveMessage: (message) => {
        // VS Code answers debugpy's `terminated` event with a `disconnect`
        // request, so only a request sent while the program still runs means
        // the user stopped it.
        if (
          !state.ended &&
          message?.type === 'request' &&
          ['disconnect', 'terminate', 'restart'].includes(message.command)
        ) {
          state.stopped = true;
        }
      },
      onDidSendMessage: (message) => {
        if (message?.type === 'response' && message.success === false) {
          if (message.command === 'launch' || message.command === 'attach') {
            state.launchError =
              message.body?.error?.format ?? message.message ?? 'launch failed';
          }
        } else if (message?.type === 'event') {
          if (message.event === 'exited' || message.event === 'terminated') {
            state.ended = true;
          }
          if (message.event === 'exited' && typeof message.body?.exitCode === 'number') {
            state.exitCode = message.body.exitCode;
          } else if (
            message.event === 'output' &&
            typeof message.body?.output === 'string'
          ) {
            appendOutput(message.body.output);
          }
        }
      },
      onError: (error) => {
        // Connection errors while the adapter shuts down after the program
        // ended are not failures of the run.
        if (!state.ended) {
          state.adapterError ??= describeError(error);
        }
      },
      onExit: (code, signal) => {
        if (
          state.exitCode === undefined &&
          !state.stopped &&
          !state.launchError &&
          (code || signal)
        ) {
          state.adapterError ??= `debug adapter exited unexpectedly (${
            signal ? `signal ${signal}` : `code ${code}`
          })`;
        }
      },
    };
  }

  private onTerminate(session: vscode.DebugSession): void {
    const state = this.states.get(session.id);

    // debugpy starts a child session for every Python subprocess, copying the
    // launch configuration (CharmRun's keys included). Only the session
    // CharmRun launched decides the outcome and is reported.
    if (isSubprocessSession(session)) {
      this.states.delete(session.id);
      return;
    }

    const token = session.configuration[LAUNCH_TOKEN_KEY];
    const waiter = typeof token === 'string' ? this.waiters.get(token) : undefined;
    if (typeof token === 'string') {
      this.waiters.delete(token);
    }

    if (!state) {
      waiter?.({ stopped: false });
      return;
    }
    this.states.delete(session.id);
    this.report(session, state);
    waiter?.(state);
  }

  private report(session: vscode.DebugSession, state: SessionState): void {
    const name = session.name;

    if (state.stopped) {
      this.output.appendLine(`[run] "${name}" was stopped`);
      return;
    }

    if (state.launchError) {
      this.output.appendLine(`[run] "${name}" failed to launch: ${state.launchError}`);
      return;
    }

    if (state.adapterError) {
      this.output.appendLine(`[run] "${name}" failed: ${state.adapterError}`);
      void this.showError(
        `PyCharm-style Run: "${name}" failed to run: ${state.adapterError}`,
        session
      );
      return;
    }

    if (state.exitCode === undefined) {
      this.output.appendLine(`[run] "${name}" ended`);
      return;
    }

    this.output.appendLine(`[run] "${name}" exited with code ${state.exitCode}`);
    if (state.exitCode !== 0) {
      void this.showError(
        `PyCharm-style Run: "${name}" exited with code ${state.exitCode}.`,
        session
      );
    }
  }

  private async showError(
    message: string,
    session: vscode.DebugSession
  ): Promise<void> {
    const showOutput = 'Show Output';
    const choice = await vscode.window.showErrorMessage(message, showOutput);
    if (choice !== showOutput) {
      return;
    }
    switch (session.configuration.console) {
      case 'integratedTerminal':
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
        break;
      case 'internalConsole':
        await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
        break;
      default:
        this.output.show(true);
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.waiters.forEach((resolve) => resolve({ stopped: true }));
    this.waiters.clear();
  }
}

function isSubprocessSession(session: vscode.DebugSession): boolean {
  return session.parentSession?.configuration[MANAGED_KEY] === true;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
