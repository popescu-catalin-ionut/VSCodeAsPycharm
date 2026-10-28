// State behind the PyCharm-style Debug panel: one entry per debug session (a tab), with its threads, frames,
// variables, watches and console. It talks to the debugger only through DapSession (Debug Adapter Protocol
// requests), so it works with any debugger and can be tested with a fake one.

/** The part of vscode.DebugSession the panel uses. customRequest resolves with the response body. */
export interface DapSession {
  readonly id: string;
  readonly name: string;
  customRequest(command: string, args?: unknown): Thenable<any>;
}

export interface VarNode {
  name: string;
  value: string;
  type?: string;
  /** > 0 when the value has children (expand with this reference). */
  ref: number;
  /** A group of members rather than a value (e.g. "Protected Attributes", "Globals"). */
  group?: boolean;
}

export interface FrameView {
  id: number;
  name: string;
  /** File name for display ("car.py"), and full path for navigation. */
  file?: string;
  path?: string;
  line: number;
  column: number;
}

export interface WatchView {
  expression: string;
  result?: VarNode;
  error?: string;
}

export interface ConsoleLine {
  category: 'stdout' | 'stderr' | 'console' | 'input' | 'result' | 'error';
  text: string;
}

export type SessionState = 'running' | 'stopped' | 'ended';

export interface SessionView {
  id: string;
  name: string;
  state: SessionState;
  stopReason?: string;
  /** Counts stops, so the page can tell one stop from the next even at the same frame. */
  stops: number;
  threads: { id: number; name: string }[];
  threadId?: number;
  frames: FrameView[];
  frameId?: number;
  /** The first scope's members (the frame's locals), shown at the top level like PyCharm. */
  variables: VarNode[];
  /** The other scopes (Globals, ...), shown as expandable groups below. */
  scopes: VarNode[];
  watches: WatchView[];
  console: ConsoleLine[];
  /** Lines ever written (the console keeps only the last ones); lets the page append just the new lines. */
  consoleTotal: number;
}

export interface PanelState {
  sessions: SessionView[];
  activeId?: string;
}

export type StepAction = 'resume' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut';

const MAX_CONSOLE_LINES = 2000;
const MAX_FRAMES = 200;

// debugpy's group names (variablePresentation "group") as PyCharm names them.
const GROUP_NAMES: Record<string, string> = {
  'special variables': 'Special Variables',
  'protected variables': 'Protected Attributes',
  'function variables': 'Function Variables',
  'class variables': 'Class Variables',
};

interface Entry {
  session: DapSession;
  view: SessionView;
  /** Bumped on every stop/continue; replies to older requests are dropped. */
  generation: number;
}

export class DebugModel {
  private entries = new Map<string, Entry>();
  private watchExpressions: string[] = [];
  private listeners: Array<() => void> = [];
  /** Waiting for a session's next stop (true) or its end (false). */
  private stopWaiters = new Map<string, Array<(stopped: boolean) => void>>();

  /** Resolves once the session stops again (frames loaded): true; or ends: false. */
  nextStop(id: string): Promise<boolean> {
    return new Promise((resolve) => this.stopWaiters.set(id, [...(this.stopWaiters.get(id) ?? []), resolve]));
  }

  private settleStopWaiters(id: string, stopped: boolean): void {
    const waiters = this.stopWaiters.get(id) ?? [];
    this.stopWaiters.delete(id);
    waiters.forEach((w) => w(stopped));
  }
  activeId?: string;

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }

  get state(): PanelState {
    return { sessions: [...this.entries.values()].map((e) => e.view), activeId: this.activeId };
  }

  session(id: string | undefined): SessionView | undefined {
    return id === undefined ? undefined : this.entries.get(id)?.view;
  }

  /** The debugger session behind a tab (the real vscode.DebugSession in the extension). */
  dapSession(id: string | undefined): DapSession | undefined {
    return id === undefined ? undefined : this.entries.get(id)?.session;
  }

  // --- sessions (tabs) -------------------------------------------------------------------------------------

  addSession(session: DapSession): void {
    if (this.entries.has(session.id)) {
      return;
    }
    this.entries.set(session.id, {
      session,
      generation: 0,
      view: {
        id: session.id, name: session.name, state: 'running', stops: 0, threads: [], frames: [], variables: [], scopes: [],
        watches: this.watchExpressions.map((expression) => ({ expression })), console: [], consoleTotal: 0,
      },
    });
    this.activeId = session.id;
    this.changed();
  }

  /** The session ended; its tab stays (with its console) until closed, as in PyCharm. */
  endSession(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.view.state === 'ended') {
      return;
    }
    entry.generation++;
    Object.assign(entry.view, { state: 'ended', stopReason: undefined, threads: [], frames: [], variables: [], scopes: [] });
    entry.view.threadId = entry.view.frameId = undefined;
    this.settleStopWaiters(id, false);
    this.changed();
  }

  closeSession(id: string): void {
    if (!this.entries.delete(id)) {
      return;
    }
    this.settleStopWaiters(id, false);
    if (this.activeId === id) {
      this.activeId = [...this.entries.keys()].pop();
    }
    this.changed();
  }

  selectSession(id: string): void {
    if (this.entries.has(id)) {
      this.activeId = id;
      this.changed();
    }
  }

  // --- debugger events ---------------------------------------------------------------------------------------

  /** The program stopped (breakpoint, step, pause, exception): load threads, frames and the top frame's variables. */
  async stopped(id: string, threadId?: number, reason?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    const generation = ++entry.generation;
    const view = entry.view;
    view.state = 'stopped';
    view.stopReason = reason;
    view.stops++;
    this.activeId = id;

    const threads = await this.request(entry, 'threads');
    if (generation !== entry.generation) {
      return;
    }
    view.threads = (threads?.threads ?? []).map((t: any) => ({ id: t.id, name: t.name }));
    view.threadId = threadId ?? view.threads[0]?.id;
    await this.loadFrames(entry, generation);
    if (generation === entry.generation) {
      this.settleStopWaiters(id, true);
    }
  }

  /**
   * PyCharm's "Step Into My Code": step into, then keep stepping while the program is in library code (the
   * standard library, site-packages, a virtual environment), so it stops at the next line of your own code. Stops
   * early at a breakpoint or exception. After `maxSteps` steps still in library code, it steps out instead.
   */
  async stepIntoMyCode(id: string, isMyCode: (path: string | undefined) => boolean, maxSteps = 300): Promise<void> {
    if (this.entries.get(id)?.view.state !== 'stopped') {
      return;
    }
    for (const [action, limit] of [['stepInto', maxSteps], ['stepOut', 50]] as const) {
      for (let i = 0; i < limit; i++) {
        const stop = this.nextStop(id);
        if (!(await this.step(id, action))) {
          return; // refused: the program is where it was
        }
        if (!(await stop)) {
          return; // the program ended
        }
        const view = this.entries.get(id)?.view;
        if (!view || (view.stopReason !== 'step' && view.stopReason !== undefined) || isMyCode(view.frames[0]?.path)) {
          return; // a breakpoint, an exception, or your code
        }
      }
    }
  }

  /** A session restarted under the same id (its debugger initialized again): it runs again. */
  restarted(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.view.state === 'ended') {
      entry.generation++;
      entry.view.state = 'running';
      this.changed();
    }
  }

  /** The program runs again (all threads, or one). */
  continued(id: string, threadId?: number, allThreads = true): void {
    const entry = this.entries.get(id);
    if (!entry || entry.view.state === 'ended') {
      return;
    }
    if (!allThreads && threadId !== undefined && threadId !== entry.view.threadId) {
      return; // another thread resumed; the one shown is still stopped
    }
    entry.generation++;
    Object.assign(entry.view, { state: 'running', stopReason: undefined, frames: [], variables: [], scopes: [] });
    entry.view.frameId = undefined;
    this.changed();
  }

  output(id: string, category: string | undefined, text: string): void {
    const entry = this.entries.get(id);
    if (!entry || !text) {
      return;
    }
    const kind: ConsoleLine['category'] = category === 'stderr' ? 'stderr' : category === 'stdout' ? 'stdout' : 'console';
    this.appendConsole(entry, kind, text);
    this.changed();
  }

  // --- selections ----------------------------------------------------------------------------------------------

  async selectThread(id: string, threadId: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.view.state !== 'stopped') {
      return;
    }
    entry.view.threadId = threadId;
    await this.loadFrames(entry, ++entry.generation);
  }

  async selectFrame(id: string, frameId: number): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || !entry.view.frames.some((f) => f.id === frameId)) {
      return;
    }
    entry.view.frameId = frameId;
    await this.loadVariables(entry, ++entry.generation);
  }

  /** The frame above (-1) or below (+1) the selected one, for "switch frames from anywhere". */
  async moveFrame(delta: number): Promise<FrameView | undefined> {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    if (!entry || entry.view.state !== 'stopped') {
      return undefined;
    }
    const frames = entry.view.frames;
    const index = frames.findIndex((f) => f.id === entry.view.frameId);
    const next = frames[Math.min(Math.max(index + delta, 0), frames.length - 1)];
    if (next && next.id !== entry.view.frameId) {
      await this.selectFrame(entry.view.id, next.id);
    }
    return next;
  }

  /**
   * PyCharm's "Show Execution Point": back to where the shown thread is paused (its top frame), whichever frame was
   * selected. Undefined when no program is paused.
   */
  async showExecutionPoint(): Promise<FrameView | undefined> {
    const entry = this.activeId === undefined ? undefined : this.entries.get(this.activeId);
    const top = entry?.view.state === 'stopped' ? entry.view.frames[0] : undefined;
    if (entry && top && entry.view.frameId !== top.id) {
      await this.selectFrame(entry.view.id, top.id);
    }
    return top;
  }

  /** True when the selected frame is not the top one, i.e. VS Code does not highlight it itself. */
  selectedIsBelowTop(id?: string): boolean {
    const view = this.session(id ?? this.activeId);
    return Boolean(view && view.state === 'stopped' && view.frameId !== undefined && view.frameId !== view.frames[0]?.id);
  }

  selectedFrame(id?: string): FrameView | undefined {
    const view = this.session(id ?? this.activeId);
    return view?.frames.find((f) => f.id === view.frameId);
  }

  // --- variables, watches, console -------------------------------------------------------------------------

  async children(id: string, ref: number): Promise<VarNode[]> {
    const entry = this.entries.get(id);
    if (!entry || ref <= 0) {
      return [];
    }
    const body = await this.request(entry, 'variables', { variablesReference: ref });
    return (body?.variables ?? []).map(toVarNode);
  }

  addWatch(expression: string): void {
    expression = expression.trim();
    if (!expression || this.watchExpressions.includes(expression)) {
      return;
    }
    this.watchExpressions.push(expression);
    for (const entry of this.entries.values()) {
      entry.view.watches.push({ expression });
      if (entry.view.state === 'stopped') {
        void this.evaluateWatches(entry, entry.generation).then(() => this.changed());
      }
    }
    this.changed();
  }

  removeWatch(expression: string): void {
    this.watchExpressions = this.watchExpressions.filter((w) => w !== expression);
    for (const entry of this.entries.values()) {
      entry.view.watches = entry.view.watches.filter((w) => w.expression !== expression);
    }
    this.changed();
  }

  /** Evaluate in the selected frame. context "repl" also writes the input and result to the console. */
  async evaluate(id: string, expression: string, context: 'watch' | 'repl' = 'watch'): Promise<WatchView> {
    const entry = this.entries.get(id);
    const result: WatchView = { expression };
    if (!entry) {
      return { expression, error: 'no debug session' };
    }
    if (context === 'repl') {
      this.appendConsole(entry, 'input', '>>> ' + expression);
    }
    try {
      const body = await entry.session.customRequest('evaluate', { expression, frameId: entry.view.frameId, context });
      result.result = { name: expression, value: String(body?.result ?? ''), type: body?.type || undefined, ref: body?.variablesReference ?? 0 };
      if (context === 'repl' && result.result.value) {
        this.appendConsole(entry, 'result', result.result.value);
      }
    } catch (error) {
      result.error = message(error);
      if (context === 'repl') {
        this.appendConsole(entry, 'error', result.error);
      }
    }
    if (context === 'repl') {
      this.changed();
    }
    return result;
  }

  /** Toolbar step actions, on the shown thread. The panel shows "running" right away. */
  /** Sends the step; false when it was not possible or the debugger refused it. */
  async step(id: string, action: StepAction): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.view.state === 'ended') {
      return false;
    }
    const threadId = entry.view.threadId ?? entry.view.threads[0]?.id ?? 0;
    const command = { resume: 'continue', pause: 'pause', stepOver: 'next', stepInto: 'stepIn', stepOut: 'stepOut' }[action];
    if (action === 'pause' ? entry.view.state !== 'running' : entry.view.state !== 'stopped') {
      return false;
    }
    const reason = entry.view.stopReason;
    if (action !== 'pause') {
      this.continued(id, threadId, true);
    }
    try {
      await entry.session.customRequest(command, { threadId });
      return true;
    } catch (error) {
      this.appendConsole(entry, 'error', `${command} failed: ${message(error)}`);
      if (action !== 'pause') {
        await this.stopped(id, threadId, reason); // the program did not move: show where it still is
      } else {
        this.changed();
      }
      return false;
    }
  }

  // --- loading -------------------------------------------------------------------------------------------------

  private async loadFrames(entry: Entry, generation: number): Promise<void> {
    const view = entry.view;
    const body = view.threadId === undefined
      ? undefined
      : await this.request(entry, 'stackTrace', { threadId: view.threadId, startFrame: 0, levels: MAX_FRAMES });
    if (generation !== entry.generation) {
      return;
    }
    view.frames = (body?.stackFrames ?? []).map((f: any) => ({
      id: f.id,
      name: f.name,
      file: f.source?.name ?? (f.source?.path ? baseName(f.source.path) : undefined),
      path: f.source?.path,
      line: f.line,
      column: f.column,
    }));
    view.frameId = view.frames[0]?.id;
    await this.loadVariables(entry, generation);
  }

  private async loadVariables(entry: Entry, generation: number): Promise<void> {
    const view = entry.view;
    const body = view.frameId === undefined ? undefined : await this.request(entry, 'scopes', { frameId: view.frameId });
    if (generation !== entry.generation) {
      return;
    }
    const scopes: any[] = body?.scopes ?? [];
    const first = scopes.find((s) => !s.expensive) ?? scopes[0];
    const locals = first ? await this.children(view.id, first.variablesReference) : [];
    if (generation !== entry.generation) {
      return;
    }
    view.variables = locals;
    view.scopes = scopes.filter((s) => s !== first).map((s) => ({ name: s.name, value: '', ref: s.variablesReference, group: true }));
    await this.evaluateWatches(entry, generation);
    if (generation === entry.generation) {
      this.changed();
    }
  }

  private async evaluateWatches(entry: Entry, generation: number): Promise<void> {
    const results = await Promise.all(entry.view.watches.map((w) => this.evaluate(entry.view.id, w.expression, 'watch')));
    if (generation === entry.generation) {
      // Watches removed or added meanwhile: keep the current list, with the new results where there are some.
      const byExpression = new Map(results.map((r) => [r.expression, r]));
      entry.view.watches = entry.view.watches.map((w) => byExpression.get(w.expression) ?? w);
    }
  }

  private async request(entry: Entry, command: string, args?: unknown): Promise<any> {
    try {
      return await entry.session.customRequest(command, args);
    } catch (error) {
      this.appendConsole(entry, 'error', `${command}: ${message(error)}`);
      return undefined;
    }
  }

  private appendConsole(entry: Entry, category: ConsoleLine['category'], text: string): void {
    const console = entry.view.console;
    console.push({ category, text });
    entry.view.consoleTotal++;
    if (console.length > MAX_CONSOLE_LINES) {
      console.splice(0, console.length - MAX_CONSOLE_LINES);
    }
  }
}

function toVarNode(v: any): VarNode {
  const renamed = GROUP_NAMES[v.name];
  const isGroup = Boolean(renamed) || v.presentationHint?.kind === 'virtual';
  return {
    name: renamed ?? v.name,
    value: isGroup ? '' : String(v.value ?? ''),
    type: isGroup ? undefined : v.type || undefined,
    ref: v.variablesReference ?? 0,
    group: isGroup || undefined,
  };
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
