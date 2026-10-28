// Connects the PyCharm-style Debug panel to VS Code: debug sessions and their protocol messages feed the model;
// the panel's clicks become debugger requests, editor navigation and VS Code debug commands.
import {
  commands, debug, DebugSession, Disposable, ExtensionContext, OverviewRulerLane, Range, ThemeColor, Uri,
  Webview, WebviewView, WebviewViewProvider, window, workspace,
} from 'vscode';
import { DebugModel, StepAction } from './model';
import { getDebugPanelHtml, getNonce } from './html';
import { registerVariablePresentation } from './presentation';

export const DEBUG_PANEL_VIEW = 'aspycharm.debugPanel';

/** PyCharm brings the Debug window forward when the program stops by itself, not after each step you take. */
export function revealsPanel(reason: string | undefined): boolean {
  return reason !== 'step' && reason !== 'goto';
}
const STEP_ACTIONS = new Set<string>(['resume', 'pause', 'stepOver', 'stepInto', 'stepOut']);

export class DebugPanelProvider implements WebviewViewProvider, Disposable {
  private view?: WebviewView;
  private breakpointsMuted = false;
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

  /** Rerun this tab's configuration: VS Code's restart while it runs, a fresh start once it has ended. */
  private async rerun(id: string | undefined): Promise<void> {
    let session = this.debugSession(id);
    // A Python subprocess has its own child session: rerun the program that started it, not the child alone.
    while (session?.parentSession) {
      session = session.parentSession;
    }
    if (!session) {
      return;
    }
    id = session.id;
    if (this.model.session(id)?.state !== 'ended' && debug.activeDebugSession?.id === session.id) {
      await commands.executeCommand('workbench.action.debug.restart');
      return;
    }
    await this.stop(id);
    this.model.closeSession(session.id);
    await debug.startDebugging(session.workspaceFolder, session.configuration);
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
    registerVariablePresentation(),
  );
  return provider;
}
