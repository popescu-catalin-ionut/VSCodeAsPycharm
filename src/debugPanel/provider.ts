// Connects the PyCharm-style Debug panel to VS Code: debug sessions and their protocol messages feed the model;
// the panel's clicks become debugger requests, editor navigation and VS Code debug commands.
import {
  commands, debug, DebugConfiguration, DebugSession, Disposable, ExtensionContext, OverviewRulerLane, Range, TextEditor,
  TextEditorRevealType, ThemeColor, Uri, Webview, WebviewView, WebviewViewProvider, window, workspace,
} from 'vscode';
import { DebugModel, StepAction, WatchView } from './model';
import { isUserCode } from './userCode';
import { getDebugPanelHtml, getNonce } from './html';
import { registerVariablePresentation } from './presentation';

export const DEBUG_PANEL_VIEW = 'aspycharm.debugPanel';

// Fields the debugger and VS Code add while starting a session; a new start computes them again.
const INTERNAL_KEYS = ['__configurationTarget', '__sessionId', 'debugAdapterPython', 'debugLauncherPython', 'charmrunLaunchToken'];

/**
 * How to run a session's program again. Its configuration as it was resolved at the first start: variables like
 * ${file} are already replaced by the paths used then, so the same script runs, whatever editor is open now.
 */
export function planRerun(resolved: DebugConfiguration): { runId?: string; configuration: DebugConfiguration; noDebug: boolean } {
  const configuration: DebugConfiguration = { ...resolved };
  for (const key of INTERNAL_KEYS) {
    delete configuration[key];
  }
  const runId = typeof resolved.charmrunRunId === 'string' ? resolved.charmrunRunId : undefined;
  delete configuration.charmrunRunId;
  return { runId, configuration, noDebug: resolved.noDebug === true };
}

/** What Evaluate Expression starts with: the editor's selection, or the dotted name under the cursor. */
export function expressionAtCursor(editor = window.activeTextEditor): string {
  if (!editor) {
    return '';
  }
  if (!editor.selection.isEmpty) {
    return editor.document.getText(editor.selection).trim();
  }
  const range = editor.document.getWordRangeAtPosition(editor.selection.active, /[A-Za-z_][\w.]*/);
  return range ? editor.document.getText(range).replace(/\.+$/, '') : '';
}

/** PyCharm brings the Debug window forward when the program stops by itself, not after each step you take. */
export function revealsPanel(reason: string | undefined): boolean {
  return reason !== 'step' && reason !== 'goto';
}
const STEP_ACTIONS = new Set<string>(['resume', 'pause', 'stepOver', 'stepInto', 'stepOut']);

export class DebugPanelProvider implements WebviewViewProvider, Disposable {
  private view?: WebviewView;
  private breakpointsMuted = false;
  /** An Evaluate Expression result waiting for the panel's page. */
  private pendingEvaluated?: WatchView;
  private disposables: Disposable[] = [];
  private postScheduled = false;
  private readonly frameLine = window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new ThemeColor('editor.focusedStackFrameHighlightBackground'),
    overviewRulerColor: new ThemeColor('editor.focusedStackFrameHighlightBackground'),
    overviewRulerLane: OverviewRulerLane.Full,
  });

  constructor(readonly model = new DebugModel()) {
    this.disposables.push(this.frameLine, model.onDidChange(() => {
      this.schedulePost();
      if (!model.selectedIsBelowTop()) {
        this.clearFrameHighlight(); // resumed, ended, or back at the top frame (which VS Code highlights)
      }
    }));
  }

  /** Session start/stop and every debugger's events (stopped, continued, output, ...). */
  watchDebugSessions(): Disposable {
    const showOnStop = () => workspace.getConfiguration('aspycharm.debug').get<boolean>('showPanelOnBreakpoint', true);
    return Disposable.from(
      debug.onDidStartDebugSession((s) => this.model.addSession(s)),
      debug.onDidTerminateDebugSession((s) => this.model.endSession(s.id)),
      debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session: DebugSession) => ({
          onDidSendMessage: (m: any) => {
            if (m?.type !== 'event') {
              return;
            }
            switch (m.event) {
              case 'stopped':
                // VS Code itself opens and highlights the line the program stopped at.
                this.model.addSession(session);
                void this.model.stopped(session.id, m.body?.threadId, m.body?.reason);
                if (showOnStop() && revealsPanel(m.body?.reason)) {
                  this.reveal();
                }
                break;
              case 'initialized':
                this.model.restarted(session.id); // a restart that kept the session
                break;
              case 'continued':
                this.model.continued(session.id, m.body?.threadId, m.body?.allThreadsContinued !== false);
                break;
              case 'output':
                if (m.body?.category !== 'telemetry') {
                  this.model.output(session.id, m.body?.category, String(m.body?.output ?? ''));
                }
                break;
              case 'terminated':
              case 'exited':
                this.model.endSession(session.id);
                break;
            }
          },
        }),
      }),
    );
  }

  resolveWebviewView(view: WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getDebugPanelHtml(view.webview.cspSource, getNonce());
    view.webview.onDidReceiveMessage((m) => this.handleMessage(m, view.webview), undefined, this.disposables);
    view.onDidDispose(() => { this.view = undefined; }, undefined, this.disposables);
  }

  /** Brings the panel forward. Keeps the keyboard in the editor, where stepping keys and typing go. */
  reveal(): void {
    if (this.view) {
      this.view.show(true);
      return;
    }
    // Not opened yet: only the focus command can open it, and it moves the focus; give it back to the editor.
    const editorHadFocus = window.activeTextEditor !== undefined;
    void commands.executeCommand(`${DEBUG_PANEL_VIEW}.focus`).then(() => {
      if (editorHadFocus) {
        return commands.executeCommand('workbench.action.focusActiveEditorGroup');
      }
    });
  }

  async handleMessage(m: any, webview: Webview): Promise<void> {
    const model = this.model;
    switch (m?.type) {
      case 'ready':
        this.post();
        this.postEvaluated(); // an Evaluate Expression made before the panel was first opened
        break;
      case 'selectSession':
        model.selectSession(m.id);
        this.revealSelectedFrame();
        break;
      case 'closeSession':
        if (model.session(m.id)?.state !== 'ended') {
          await this.stop(m.id);
        }
        model.closeSession(m.id);
        break;
      case 'selectThread':
        await model.selectThread(m.id, m.threadId);
        this.revealSelectedFrame();
        break;
      case 'selectFrame':
        await model.selectFrame(m.id, m.frameId);
        this.revealSelectedFrame();
        break;
      case 'children':
        void webview.postMessage({ type: 'children', reqId: m.reqId, nodes: await model.children(m.id, m.ref) });
        break;
      case 'evaluate':
        void webview.postMessage({ type: 'evaluated', result: await model.evaluate(m.id, String(m.expression), 'watch') });
        break;
      case 'addWatch':
        model.addWatch(String(m.expression));
        break;
      case 'removeWatch':
        model.removeWatch(String(m.expression));
        break;
      case 'console':
        await model.evaluate(m.id, String(m.text), 'repl');
        break;
      case 'action':
        await this.action(m.id, String(m.action));
        break;
    }
  }

  private async action(id: string | undefined, action: string): Promise<void> {
    if (STEP_ACTIONS.has(action)) {
      if (id) {
        await this.model.step(id, action as StepAction);
      }
      return;
    }
    switch (action) {
      case 'stepIntoMyCode':
        if (id) {
          await this.stepIntoMyCode(id);
        }
        break;
      case 'runToCursor':
        await this.runToCursor();
        break;
      case 'evaluateExpression':
        if (id) {
          this.model.selectSession(id);
        }
        await this.evaluateExpression();
        break;
      case 'showExecutionPoint':
        if (id) {
          this.model.selectSession(id);
        }
        await this.showExecutionPoint();
        break;
      case 'stop':
        await this.stop(id);
        break;
      case 'rerun':
        await this.rerun(id);
        break;
      case 'viewBreakpoints':
        await commands.executeCommand('workbench.debug.action.focusBreakpointsView');
        break;
      case 'muteBreakpoints':
        await commands.executeCommand('workbench.debug.viewlet.action.toggleBreakpointsActivatedAction');
        this.breakpointsMuted = !this.breakpointsMuted;
        this.post();
        break;
    }
  }

  /** The real session behind a tab (a test fake has no configuration and is not a VS Code session). */
  private debugSession(id: string | undefined): DebugSession | undefined {
    const s = this.model.dapSession(id) as DebugSession | undefined;
    return s && 'configuration' in s ? s : undefined;
  }

  private async stop(id: string | undefined): Promise<void> {
    const session = this.debugSession(id);
    if (session) {
      await debug.stopDebugging(session);
    }
  }

  /**
   * Rerun this tab's program, as PyCharm does: the same script and mode as the first time. Not VS Code's Restart:
   * that substitutes variables again, so "${file}" became whatever file was open by then (e.g. the module you were
   * paused in) and the wrong script ran.
   */
  private async rerun(id: string | undefined): Promise<void> {
    let session = this.debugSession(id);
    // A Python subprocess has its own child session: rerun the program that started it, not the child alone.
    while (session?.parentSession) {
      session = session.parentSession;
    }
    if (!session) {
      return;
    }
    const plan = planRerun(session.configuration);
    if (this.model.session(session.id)?.state !== 'ended') {
      await this.stop(session.id);
    }
    this.model.closeSession(session.id);
    // Started by PyCharm-style Run: repeat that run (its before-launch steps too).
    if (plan.runId) {
      try {
        if (await commands.executeCommand<boolean>('charmrun.rerunLaunch', plan.runId)) {
          return;
        }
      } catch {
        // PyCharm-style Run is not available: start the configuration below instead
      }
    }
    await debug.startDebugging(session.workspaceFolder, plan.configuration, { noDebug: plan.noDebug });
  }

  /** PyCharm's "Step Into My Code" (Alt+Shift+F7): into the next line of project code, past library code. */
  async stepIntoMyCode(id: string | undefined = this.model.activeId): Promise<void> {
    if (!id || this.model.session(id)?.state !== 'stopped') {
      window.setStatusBarMessage('No program is paused in the debugger', 3000);
      return;
    }
    const roots = (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    await this.model.stepIntoMyCode(id, (file) => isUserCode(file, roots));
  }

  /** PyCharm's "Run to Cursor" (Alt+F9): continue to the line with the cursor in the editor. */
  async runToCursor(): Promise<void> {
    if (this.model.session(this.model.activeId)?.state !== 'stopped') {
      window.setStatusBarMessage('No program is paused in the debugger', 3000);
      return;
    }
    if (!window.activeTextEditor) {
      window.setStatusBarMessage('Put the cursor on a line in the editor first', 3000);
      return;
    }
    await commands.executeCommand('editor.debug.action.runToCursor');
  }

  /**
   * PyCharm's "Evaluate Expression" (Alt+F8): asks for an expression (the selection, or the name under the cursor,
   * is filled in), evaluates it in the selected frame and shows "result = ..." at the top of the variables.
   */
  async evaluateExpression(expression?: string): Promise<WatchView | undefined> {
    const id = this.model.activeId;
    if (!id || this.model.session(id)?.state !== 'stopped') {
      window.setStatusBarMessage('No program is paused in the debugger', 3000);
      return undefined;
    }
    let text = expression;
    if (text === undefined) {
      const value = expressionAtCursor();
      text = await window.showInputBox({
        title: 'Evaluate Expression',
        prompt: 'A Python expression, evaluated in the selected frame',
        value,
        valueSelection: [0, value.length],
      });
    }
    if (!text?.trim()) {
      return undefined;
    }
    const result = await this.model.evaluate(id, text.trim(), 'watch');
    this.pendingEvaluated = result;
    this.reveal();
    this.postEvaluated();
    return result;
  }

  private postEvaluated(): void {
    if (this.view && this.pendingEvaluated) {
      void this.view.webview.postMessage({ type: 'showTab', tab: 'variables' });
      void this.view.webview.postMessage({ type: 'evaluated', result: this.pendingEvaluated });
      this.pendingEvaluated = undefined;
    }
  }

  /**
   * PyCharm's "Show Execution Point" (Alt+F10): select the frame where the program is paused and bring its line into
   * view in the editor, with the keyboard there, wherever you have navigated meanwhile.
   */
  async showExecutionPoint(): Promise<TextEditor | undefined> {
    const frame = await this.model.showExecutionPoint();
    if (!frame) {
      window.setStatusBarMessage('No program is paused in the debugger', 3000);
      return undefined;
    }
    if (!frame.path) {
      window.setStatusBarMessage(`The paused line (${frame.name}) has no file to show`, 3000);
      return undefined;
    }
    const at = new Range(Math.max(0, frame.line - 1), Math.max(0, frame.column - 1), Math.max(0, frame.line - 1), Math.max(0, frame.column - 1));
    try {
      const editor = await window.showTextDocument(Uri.file(frame.path), { preserveFocus: false, preview: true, selection: at });
      editor.revealRange(at, TextEditorRevealType.InCenterIfOutsideViewport);
      this.clearFrameHighlight(); // the top frame: VS Code highlights it itself
      return editor;
    } catch {
      window.setStatusBarMessage(`Cannot open ${frame.path}`, 3000);
      return undefined;
    }
  }

  /** Frame up/down from anywhere (Ctrl+Alt+Up / Ctrl+Alt+Down). */
  async moveFrame(delta: number): Promise<void> {
    if (await this.model.moveFrame(delta)) {
      this.revealSelectedFrame();
    }
  }

  /** Opens the selected frame's line in the editor and highlights it, like clicking a frame in PyCharm. */
  revealSelectedFrame(): void {
    const frame = this.model.selectedFrame();
    if (!frame?.path) {
      return;
    }
    const line = Math.max(0, frame.line - 1);
    void window.showTextDocument(Uri.file(frame.path), {
      preserveFocus: true,
      preview: true,
      selection: new Range(line, Math.max(0, frame.column - 1), line, Math.max(0, frame.column - 1)),
    }).then(
      (editor) => {
        this.clearFrameHighlight();
        // The top frame is VS Code's own current line; a lower frame gets the "focused frame" highlight.
        if (this.model.selectedIsBelowTop()) {
          editor.setDecorations(this.frameLine, [new Range(line, 0, line, 0)]);
        }
      },
      () => undefined, // the file is gone or not on disk: nothing to show
    );
  }

  private clearFrameHighlight(): void {
    window.visibleTextEditors.forEach((e) => e.setDecorations(this.frameLine, []));
  }

  // At most ~20 updates a second, so a program printing a lot does not flood the panel.
  private schedulePost(): void {
    if (!this.postScheduled) {
      this.postScheduled = true;
      setTimeout(() => { this.postScheduled = false; this.post(); }, 50);
    }
  }

  private post(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: 'state', state: { ...this.model.state, breakpointsMuted: this.breakpointsMuted } });
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}

export function registerDebugPanel(context: ExtensionContext): DebugPanelProvider {
  const provider = new DebugPanelProvider();
  context.subscriptions.push(
    provider,
    window.registerWebviewViewProvider(DEBUG_PANEL_VIEW, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    provider.watchDebugSessions(),
    commands.registerCommand('aspycharm.debug.frameUp', () => provider.moveFrame(-1)),
    commands.registerCommand('aspycharm.debug.frameDown', () => provider.moveFrame(1)),
    commands.registerCommand('aspycharm.debug.showPanel', () => provider.reveal()),
    commands.registerCommand('aspycharm.debug.showExecutionPoint', () => provider.showExecutionPoint()),
    commands.registerCommand('aspycharm.debug.stepIntoMyCode', () => provider.stepIntoMyCode()),
    commands.registerCommand('aspycharm.debug.runToCursor', () => provider.runToCursor()),
    commands.registerCommand('aspycharm.debug.evaluateExpression', () => provider.evaluateExpression()),
    registerVariablePresentation(),
  );
  return provider;
}
