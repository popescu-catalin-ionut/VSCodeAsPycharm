import * as assert from 'assert';
import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { commands, extensions, Selection, window, workspace } from 'vscode';
import { DapSession, DebugModel } from '../../debugPanel/model';
import { getDebugPanelHtml } from '../../debugPanel/html';
import { PYCHARM_PRESENTATION, withVariablePresentation } from '../../debugPanel/presentation';
import { DebugPanelProvider, expressionAtCursor, planRerun, revealsPanel } from '../../debugPanel/provider';
import { isUserCode } from '../../debugPanel/userCode';

// A scripted debugger: the car.py example from PyCharm's documentation, stopped in Car.step.
class FakeSession implements DapSession {
  readonly requests: Array<[string, any]> = [];
  time = 1;
  failEvaluate = false;
  /** Requests the debugger refuses. */
  refuse = new Set<string>();
  /** When set, evaluate waits for it (to test what happens meanwhile). */
  evaluateGate?: Promise<void>;
  /** Where frames say car.py is (a real file when a test opens it). */
  carPath = '/p/car.py';
  constructor(readonly id = 's1', readonly name = 'car') {}

  /** Scripted stack (instead of car.py's), e.g. to walk through library code. */
  frames?: () => any[];
  /** Called on every request, e.g. to answer a step with a "stopped" event. */
  onRequest?: (command: string, args: any) => void;

  async customRequest(command: string, args: any = {}): Promise<any> {
    this.requests.push([command, args]);
    if (this.refuse.has(command)) {
      throw new Error(`${command} refused`);
    }
    this.onRequest?.(command, args);
    if (command === 'stackTrace' && this.frames) {
      return { stackFrames: this.frames() };
    }
    if (command === 'evaluate' && this.evaluateGate) {
      await this.evaluateGate;
    }
    switch (command) {
      case 'threads':
        return { threads: [{ id: 1, name: 'MainThread' }, { id: 2, name: 'Worker' }] };
      case 'stackTrace':
        return args.threadId === 2
          ? { stackFrames: [{ id: 30, name: 'work', line: 3, column: 1, source: { path: '/p/worker.py', name: 'worker.py' } }] }
          : { stackFrames: [
              { id: 10, name: 'step', line: 15, column: 9, source: { path: this.carPath, name: 'car.py' } },
              { id: 11, name: '<module>', line: 42, column: 1, source: { path: this.carPath, name: 'car.py' } },
            ] };
      case 'scopes':
        return { scopes: [
          { name: 'Locals', variablesReference: 100 + args.frameId, expensive: false },
          { name: 'Globals', variablesReference: 200, expensive: false },
        ] };
      case 'variables':
        switch (args.variablesReference) {
          case 110: return { variables: [{ name: 'self', value: '<__main__.Car object at 0x103e46910>', type: 'Car', variablesReference: 500 }] };
          case 111: return { variables: [{ name: 'my_car', value: '<__main__.Car object at 0x103e46910>', type: 'Car', variablesReference: 500 }] };
          case 500: return { variables: [
            { name: 'odometer', value: '5', type: 'int', variablesReference: 0 },
            { name: 'speed', value: '0', type: 'int', variablesReference: 0 },
            { name: 'time', value: String(this.time), type: 'int', variablesReference: 0 },
            { name: 'protected variables', value: '', variablesReference: 501, presentationHint: { kind: 'virtual' } },
          ] };
          default: return { variables: [] };
        }
      case 'evaluate':
        if (this.failEvaluate || args.expression === 'nope') {
          throw new Error(`NameError: name '${args.expression}' is not defined`);
        }
        return { result: args.expression === 'my_car.time' ? String(this.time) : '42', type: 'int', variablesReference: 0 };
      default:
        return {};
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

// Just enough of a browser DOM to run the panel's script: elements from the page's ids and data attributes,
// children, classes, text, events. Writing innerHTML is counted (the script must never do it).
class FakeElement {
  children: FakeElement[] = [];
  parent?: FakeElement;
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  value = '';
  disabled = false;
  selected = false;
  title = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private listeners: Record<string, Array<(e: any) => void>> = {};
  private ownText = '';
  constructor(readonly tag: string, readonly dom: { htmlWrites: number }, readonly id = '') {}
  get classList() {
    const set = () => new Set(this.className.split(/\s+/).filter(Boolean));
    return {
      contains: (c: string) => set().has(c),
      toggle: (c: string, on?: boolean) => { const s = set(); if (on ?? !s.has(c)) { s.add(c); } else { s.delete(c); } this.className = [...s].join(' '); },
      add: (c: string) => { const s = set(); s.add(c); this.className = [...s].join(' '); },
    };
  }
  get textContent() { return this.text(); }
  set textContent(t: string) { this.children = []; this.ownText = String(t); }
  set innerHTML(_: string) { this.dom.htmlWrites++; }
  get lastChild() { return this.children[this.children.length - 1]; }
  get childNodes() { return [...this.children]; }
  text(): string { return this.ownText + this.children.map((c) => c.text()).join(''); }
  appendChild(c: FakeElement) { c.parent?.removeChild(c); c.parent = this; this.children.push(c); return c; }
  removeChild(c: FakeElement) { this.children = this.children.filter((x) => x !== c); c.parent = undefined; }
  replaceChildren(...nodes: FakeElement[]) { this.children = []; this.ownText = ''; nodes.forEach((n) => this.appendChild(n)); }
  setAttribute(k: string, v: string) { this.attributes[k] = v; }
  addEventListener(type: string, f: (e: any) => void) { (this.listeners[type] ??= []).push(f); }
  click() { (this.listeners.click ?? []).forEach((f) => f({ stopPropagation() {}, target: this })); }
  all(): FakeElement[] { return [this, ...this.children.flatMap((c) => c.all())]; }
}

function fakeDom(html: string) {
  const dom = { htmlWrites: 0 };
  const body = new FakeElement('body', dom);
  body.className = 'no-session';
  const byId = new Map<string, FakeElement>();
  for (const m of html.matchAll(/id="([\w-]+)"/g)) {
    const e = new FakeElement('div', dom, m[1]);
    byId.set(m[1], e);
    body.appendChild(e);
  }
  byId.get('tabs')!.appendChild(new FakeElement('span', dom)).textContent = 'Debug';
  const tools = [...html.matchAll(/class="(tool [^"]*)" data-action="(\w+)"/g)].map((m) => {
    const b = new FakeElement('button', dom);
    b.className = m[1];
    b.dataset.action = m[2];
    return body.appendChild(b);
  });
  const vtabs = [...html.matchAll(/class="(vtab[^"]*)" data-tab="(\w+)"/g)].map((m) => {
    const b = new FakeElement('button', dom);
    b.className = m[1];
    b.dataset.tab = m[2];
    return body.appendChild(b);
  });
  const document = {
    body,
    getElementById: (id: string) => byId.get(id),
    createElement: (tag: string) => new FakeElement(tag, dom),
    querySelectorAll: (sel: string) => (sel === '.tool' ? tools : sel === '.vtab' ? vtabs : []),
  };
  return {
    document,
    get htmlWrites() { return dom.htmlWrites; },
    allText: () => body.text(),
    find: (pred: (e: FakeElement) => boolean) => body.all().find(pred),
  };
}

/** Runs the panel's page script against a fake page; send() delivers a message from the extension. */
function runPage() {
  const html = getDebugPanelHtml('vscode-webview:', 'N');
  const script = html.slice(html.indexOf('<script nonce="N">') + '<script nonce="N">'.length, html.lastIndexOf('</script>'));
  const dom = fakeDom(html);
  const sent: any[] = [];
  let onMessage: (e: { data: any }) => void = () => undefined;
  const api = { postMessage: (m: any) => sent.push(m), getState: () => undefined, setState: () => undefined };
  new Function('acquireVsCodeApi', 'document', 'window', script)(
    () => api, dom.document, { addEventListener: (_: string, f: any) => { onMessage = f; } });
  return { dom, sent, send: (data: any) => onMessage({ data }) };
}

function setup() {
  const model = new DebugModel();
  const session = new FakeSession();
  model.addSession(session);
  return { model, session };
}

suite('Debug panel: model', () => {
  test('a stop loads threads, the frames of the stopped thread, and the top frame\'s variables with types', async () => {
    const { model } = setup();
    await model.stopped('s1', 1, 'breakpoint');
    const v = model.session('s1')!;
    assert.strictEqual(v.state, 'stopped');
    assert.deepStrictEqual(v.threads.map((t) => t.name), ['MainThread', 'Worker']);
    assert.deepStrictEqual(v.frames.map((f) => `${f.name}, ${f.file}:${f.line}`), ['step, car.py:15', '<module>, car.py:42']);
    assert.strictEqual(v.frameId, 10);
    assert.deepStrictEqual(v.variables, [{ name: 'self', value: '<__main__.Car object at 0x103e46910>', type: 'Car', ref: 500, group: undefined }]);
    assert.deepStrictEqual(v.scopes.map((s) => s.name), ['Globals'], 'other scopes become groups');
    assert.strictEqual(model.activeId, 's1');
  });

  test('expanding shows members, and debugpy\'s groups get PyCharm\'s names', async () => {
    const { model } = setup();
    await model.stopped('s1', 1);
    const kids = await model.children('s1', 500);
    assert.deepStrictEqual(kids.map((k) => `${k.name} = {${k.type}} ${k.value}`).slice(0, 3), ['odometer = {int} 5', 'speed = {int} 0', 'time = {int} 1']);
    assert.deepStrictEqual(kids[3], { name: 'Protected Attributes', value: '', type: undefined, ref: 501, group: true });
  });

  test('selecting another frame or thread shows its variables', async () => {
    const { model } = setup();
    await model.stopped('s1', 1);
    await model.selectFrame('s1', 11);
    assert.strictEqual(model.session('s1')!.variables[0].name, 'my_car');
    await model.selectThread('s1', 2);
    assert.deepStrictEqual(model.session('s1')!.frames.map((f) => f.name), ['work']);
  });

  test('frame up/down moves within the stack and stops at its ends', async () => {
    const { model } = setup();
    await model.stopped('s1', 1);
    assert.strictEqual((await model.moveFrame(1))?.name, '<module>');
    assert.strictEqual((await model.moveFrame(1))?.name, '<module>', 'stays at the bottom');
    assert.strictEqual((await model.moveFrame(-1))?.name, 'step');
  });

  test('watches are evaluated in the selected frame on every stop; errors are shown, not thrown', async () => {
    const { model, session } = setup();
    model.addWatch('my_car.time');
    model.addWatch('nope');
    model.addWatch('my_car.time');
    await model.stopped('s1', 1);
    let w = model.session('s1')!.watches;
    assert.deepStrictEqual(w.map((x) => x.expression), ['my_car.time', 'nope'], 'no duplicates');
    assert.strictEqual(w[0].result?.value, '1');
    assert.ok(w[1].error?.includes('NameError'));
    session.time = 2;
    await model.stopped('s1', 1);
    w = model.session('s1')!.watches;
    assert.strictEqual(w[0].result?.value, '2');
    const evaluate = session.requests.filter(([c]) => c === 'evaluate').pop()!;
    assert.strictEqual(evaluate[1].frameId, 10);
    model.removeWatch('nope');
    assert.deepStrictEqual(model.session('s1')!.watches.map((x) => x.expression), ['my_car.time']);
  });

  test('toolbar steps send the right request for the shown thread, and the panel shows "running" at once', async () => {
    const { model, session } = setup();
    await model.stopped('s1', 1);
    await model.selectThread('s1', 2);
    await model.step('s1', 'stepOver');
    assert.deepStrictEqual(session.requests.pop(), ['next', { threadId: 2 }]);
    assert.strictEqual(model.session('s1')!.state, 'running');
    assert.deepStrictEqual(model.session('s1')!.frames, []);
    await model.step('s1', 'stepInto');
    assert.notStrictEqual(session.requests[session.requests.length - 1][0], 'stepIn', 'no stepping while running');
    await model.step('s1', 'pause');
    assert.deepStrictEqual(session.requests.pop(), ['pause', { threadId: 2 }]);
    await model.stopped('s1', 1);
    for (const [action, command] of [['stepInto', 'stepIn'], ['stepOut', 'stepOut'], ['resume', 'continue']] as const) {
      await model.stopped('s1', 1);
      await model.step('s1', action);
      assert.strictEqual(session.requests.pop()![0], command);
    }
  });

  test('a stop that is overtaken by a newer stop or a resume does not overwrite it', async () => {
    const { model } = setup();
    const first = model.stopped('s1', 1);
    model.continued('s1');
    await first;
    assert.strictEqual(model.session('s1')!.state, 'running');
    assert.deepStrictEqual(model.session('s1')!.frames, []);
  });

  test('another thread resuming leaves the shown thread stopped', async () => {
    const { model } = setup();
    await model.stopped('s1', 1);
    model.continued('s1', 2, false);
    assert.strictEqual(model.session('s1')!.state, 'stopped');
    model.continued('s1', 1, false);
    assert.strictEqual(model.session('s1')!.state, 'running');
  });

  test('console: program output, and Python run in the selected frame (context "repl")', async () => {
    const { model, session } = setup();
    model.output('s1', 'stdout', 'hello\n');
    model.output('s1', 'stderr', 'oops\n');
    await model.stopped('s1', 1);
    await model.evaluate('s1', '6*7', 'repl');
    session.failEvaluate = true;
    await model.evaluate('s1', 'boom', 'repl');
    assert.deepStrictEqual(model.session('s1')!.console.map((l) => `${l.category}:${l.text}`), [
      'stdout:hello\n', 'stderr:oops\n', 'input:>>> 6*7', 'result:42', "input:>>> boom", "error:NameError: name 'boom' is not defined",
    ]);
    assert.deepStrictEqual(session.requests.filter(([c]) => c === 'evaluate')[0][1], { expression: '6*7', frameId: 10, context: 'repl' });
  });

  test('the console keeps the last 2000 lines', () => {
    const { model } = setup();
    for (let i = 0; i < 2100; i++) {
      model.output('s1', 'stdout', `line ${i}`);
    }
    const lines = model.session('s1')!.console;
    assert.strictEqual(lines.length, 2000);
    assert.strictEqual(lines[0].text, 'line 100');
  });

  test('session tabs: a new session becomes active; an ended one stays until closed', async () => {
    const { model } = setup();
    model.addSession(new FakeSession('s2', 'main'));
    assert.strictEqual(model.activeId, 's2');
    model.selectSession('s1');
    assert.strictEqual(model.activeId, 's1');
    model.endSession('s1');
    assert.strictEqual(model.session('s1')!.state, 'ended');
    assert.deepStrictEqual(model.state.sessions.map((s) => s.name), ['car', 'main']);
    model.closeSession('s1');
    assert.deepStrictEqual(model.state.sessions.map((s) => s.name), ['main']);
    assert.strictEqual(model.activeId, 's2');
  });

  test('a step the debugger refuses shows where the program still is (bug: stuck on "running")', async () => {
    const { model, session } = setup();
    await model.stopped('s1', 1, 'breakpoint');
    session.refuse.add('next');
    await model.step('s1', 'stepOver');
    const v = model.session('s1')!;
    assert.strictEqual(v.state, 'stopped');
    assert.deepStrictEqual(v.frames.map((f) => f.name), ['step', '<module>']);
    assert.ok(v.console.some((l) => l.text.includes('next failed')));
  });

  test('a watch removed while watches are evaluating stays removed (bug: it came back)', async () => {
    const { model, session } = setup();
    model.addWatch('a');
    model.addWatch('b');
    let release!: () => void;
    session.evaluateGate = new Promise<void>((r) => { release = r; });
    const stop = model.stopped('s1', 1);
    while (!session.requests.some(([c]) => c === 'evaluate')) {
      await tick();
    }
    model.removeWatch('b');
    model.addWatch('c');
    release();
    await stop;
    await tick();
    assert.deepStrictEqual(model.session('s1')!.watches.map((w) => w.expression), ['a', 'c']);
  });

  test('a session restarted under the same id runs again (bug: its tab stayed "ended")', () => {
    const { model } = setup();
    model.restarted('s1');
    assert.strictEqual(model.session('s1')!.state, 'running', 'no change while it runs');
    model.endSession('s1');
    model.restarted('s1');
    assert.strictEqual(model.session('s1')!.state, 'running');
  });

  test('the console counts every line written, also past the 2000 kept', () => {
    const { model } = setup();
    for (let i = 0; i < 2100; i++) {
      model.output('s1', 'stdout', `line ${i}`);
    }
    assert.strictEqual(model.session('s1')!.consoleTotal, 2100);
  });

  test('the frame highlight is only for a frame below the top (VS Code highlights the top one)', async () => {
    const { model } = setup();
    assert.strictEqual(model.selectedIsBelowTop(), false);
    await model.stopped('s1', 1);
    assert.strictEqual(model.selectedIsBelowTop(), false);
    await model.selectFrame('s1', 11);
    assert.strictEqual(model.selectedIsBelowTop(), true);
    model.continued('s1');
    assert.strictEqual(model.selectedIsBelowTop(), false, 'cleared when it runs again');
  });

  test('the panel comes forward on breakpoints, exceptions and pauses, not after each step (bug: every step)', () => {
    for (const reason of ['breakpoint', 'exception', 'pause', 'entry', undefined]) {
      assert.strictEqual(revealsPanel(reason), true, String(reason));
    }
    assert.strictEqual(revealsPanel('step'), false);
  });

  test('Show Execution Point selects the frame where the program is paused, from any other frame', async () => {
    const { model } = setup();
    assert.strictEqual(await model.showExecutionPoint(), undefined, 'nothing paused yet');
    await model.stopped('s1', 1);
    await model.selectFrame('s1', 11);
    const top = await model.showExecutionPoint();
    assert.deepStrictEqual([top?.name, top?.line], ['step', 15]);
    assert.strictEqual(model.session('s1')!.frameId, 10);
    assert.strictEqual(model.session('s1')!.variables[0].name, 'self', 'its variables are shown again');
    model.continued('s1');
    assert.strictEqual(await model.showExecutionPoint(), undefined, 'not while running');
  });

  // A program whose steps go through `files` in turn: each stepIn/stepOut lands in the next one.
  function walk(files: string[], reasons: Record<number, string> = {}) {
    const { model, session } = setup();
    let at = 0;
    session.frames = () => [{ id: 100 + at, name: 'f', line: 1, column: 1, source: { path: files[at], name: path.basename(files[at]) } }];
    session.onRequest = (command) => {
      if (command === 'stepIn' || command === 'stepOut') {
        at = Math.min(at + 1, files.length - 1);
        setTimeout(() => void model.stopped('s1', 1, reasons[at] ?? 'step'), 0);
      }
    };
    return { model, session, steps: () => session.requests.filter(([c]) => c === 'stepIn' || c === 'stepOut').map(([c]) => c) };
  }

  const project = path.join(os.tmpdir(), 'proj');
  const lib = path.join(os.tmpdir(), 'venv', 'Lib', 'site-packages', 'requests', 'api.py');
  const mine = (p: string | undefined) => isUserCode(p, [project]);

  test('Step Into My Code steps through library code to the next line of project code', async () => {
    const { model, steps } = walk([path.join(project, 'main.py'), lib, lib, path.join(project, 'handlers.py')]);
    await model.stopped('s1', 1, 'breakpoint');
    await model.stepIntoMyCode('s1', mine);
    assert.deepStrictEqual(steps(), ['stepIn', 'stepIn', 'stepIn']);
    assert.strictEqual(model.session('s1')!.frames[0].path, path.join(project, 'handlers.py'));
  });

  test('Step Into My Code stops at a breakpoint met in library code', async () => {
    const { model, steps } = walk([path.join(project, 'main.py'), lib, lib, path.join(project, 'x.py')], { 2: 'breakpoint' });
    await model.stopped('s1', 1, 'breakpoint');
    await model.stepIntoMyCode('s1', mine);
    assert.deepStrictEqual(steps(), ['stepIn', 'stepIn']);
  });

  test('Step Into My Code steps out when library code goes on too long', async () => {
    const files = [path.join(project, 'main.py'), lib, lib, lib, lib, path.join(project, 'main.py')];
    const { model, steps } = walk(files);
    await model.stopped('s1', 1, 'breakpoint');
    await model.stepIntoMyCode('s1', mine, 2);
    assert.deepStrictEqual(steps(), ['stepIn', 'stepIn', 'stepOut', 'stepOut', 'stepOut']);
    assert.ok(mine(model.session('s1')!.frames[0].path));
  });

  test('Step Into My Code ends when a step is refused or the program ends', async () => {
    const refused = walk([path.join(project, 'main.py'), lib]);
    await refused.model.stopped('s1', 1, 'breakpoint');
    refused.session.refuse.add('stepIn');
    await refused.model.stepIntoMyCode('s1', mine);
    assert.strictEqual(refused.session.requests.filter(([c]) => c === 'stepIn').length, 1);

    const { model, session } = setup();
    await model.stopped('s1', 1, 'breakpoint');
    session.onRequest = (command) => { if (command === 'stepIn') { setTimeout(() => model.endSession('s1'), 0); } };
    await model.stepIntoMyCode('s1', () => false); // would loop if the end were not noticed
    assert.strictEqual(model.session('s1')!.state, 'ended');
  });

  test('my code: files in the project, not libraries, the standard library or virtual environments', () => {
    assert.ok(isUserCode(path.join(project, 'app', 'main.py'), [project]));
    assert.ok(!isUserCode(path.join(os.tmpdir(), 'elsewhere', 'x.py'), [project]), 'outside the project');
    assert.ok(!isUserCode(path.join(project, '.venv', 'Lib', 'site-packages', 'x.py'), [project]), 'venv inside the project');
    assert.ok(!isUserCode(path.join(project, 'venv', 'lib', 'python3.12', 'json', '__init__.py'), [project]));
    assert.ok(!isUserCode('/usr/lib/python3.12/json/__init__.py', []), 'standard library (Linux)');
    assert.ok(!isUserCode('C:\\Python312\\Lib\\json\\__init__.py', []), 'standard library (Windows)');
    assert.ok(!isUserCode(undefined, [project]) && !isUserCode('<string>', [project]), 'no file');
    assert.ok(isUserCode(path.join(os.tmpdir(), 'script.py'), []), 'no folder open: any non-library file');
  });

  test('listeners hear about changes', async () => {
    const { model } = setup();
    let calls = 0;
    const sub = model.onDidChange(() => calls++);
    await model.stopped('s1', 1);
    assert.ok(calls > 0);
    sub.dispose();
    const before = calls;
    model.output('s1', 'stdout', 'x');
    assert.strictEqual(calls, before);
  });
});

suite('Debug panel: page and wiring', () => {
  test('the page has the PyCharm layout, a strict content policy, and never inserts values as HTML', () => {
    const html = getDebugPanelHtml('vscode-webview:', 'NONCE');
    assert.ok(html.includes("script-src 'nonce-NONCE'"));
    for (const part of ['Threads &amp; Variables', '>Console<', 'id="thread"', 'id="frame-list"', 'id="eval"', 'id="console-in"']) {
      assert.ok(html.includes(part), part);
    }
    for (const action of ['rerun', 'stop', 'resume', 'pause', 'stepOver', 'stepInto', 'stepOut', 'viewBreakpoints', 'muteBreakpoints']) {
      assert.ok(html.includes(`data-action="${action}"`), action);
    }
    const script = html.slice(html.indexOf('<script'));
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(script), 'values only via textContent');
  });

  test('the page script runs: renders stopped, running and ended sessions, expands nodes, sends clicks', async () => {
    const html = getDebugPanelHtml('vscode-webview:', 'N');
    const script = html.slice(html.indexOf('<script nonce="N">') + '<script nonce="N">'.length, html.lastIndexOf('</script>'));
    const dom = fakeDom(html);
    const sent: any[] = [];
    let onMessage: (e: { data: any }) => void = () => undefined;
    const api = { postMessage: (m: any) => sent.push(m), getState: () => undefined, setState: () => undefined };
    new Function('acquireVsCodeApi', 'document', 'window', script)(
      () => api, dom.document, { addEventListener: (_: string, f: any) => { onMessage = f; } });
    assert.deepStrictEqual(sent[0], { type: 'ready' });

    const { model } = setup();
    await model.stopped('s1', 1);
    model.addWatch('my_car.time');
    await model.stopped('s1', 1);
    model.output('s1', 'stdout', '<img src=x onerror=alert(1)>\n');
    onMessage({ data: { type: 'state', state: model.state } });
    await tick();
    const text = dom.allText();
    for (const shown of ['car', 'MainThread', 'step', ', car.py:15', 'my_car.time', '{int}', 'self', '{Car}', '<__main__.Car object at 0x103e46910>', 'Globals', '<img src=x onerror=alert(1)>']) {
      assert.ok(text.includes(shown), `shows ${shown}`);
    }
    assert.ok(!dom.document.body.classList.contains('no-session'));

    // Expanding "self" asks the extension for its children and shows them.
    dom.find((e) => e.className.includes('row') && e.text().includes('self'))!.click();
    await tick();
    const ask = sent.find((m) => m.type === 'children');
    assert.ok(ask, 'asked for the children of self');
    assert.deepStrictEqual([ask.id, ask.ref], ['s1', 500]);
    onMessage({ data: { type: 'children', reqId: ask.reqId, nodes: await model.children('s1', 500) } });
    await tick();
    assert.ok(dom.allText().includes('odometer') && dom.allText().includes('Protected Attributes'));

    // Clicking a frame and a toolbar button send messages.
    dom.find((e) => e.className.startsWith('frame') && e.text().includes('<module>'))!.click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'selectFrame', id: 's1', frameId: 11 });
    dom.find((e) => e.dataset.action === 'stepOver')!.click();
    assert.deepStrictEqual(sent[sent.length - 1], { type: 'action', id: 's1', action: 'stepOver' });

    for (const state of ['running', 'ended'] as const) {
      if (state === 'running') { model.continued('s1'); } else { model.endSession('s1'); }
      onMessage({ data: { type: 'state', state: model.state } });
      await tick();
      assert.ok(dom.allText().includes(state === 'running' ? 'The application is running' : 'The session has ended'));
    }
    model.closeSession('s1');
    onMessage({ data: { type: 'state', state: model.state } });
    assert.ok(dom.document.body.classList.contains('no-session'));
    assert.strictEqual(dom.htmlWrites, 0, 'nothing set as HTML');
  });

  test('debugpy configurations get PyCharm-style grouping unless they set their own or it is turned off', () => {
    assert.deepStrictEqual(withVariablePresentation({ type: 'debugpy', request: 'launch', name: 'x' }, true).variablePresentation, PYCHARM_PRESENTATION);
    const own = { type: 'debugpy', request: 'launch', name: 'x', variablePresentation: { protected: 'inline' } };
    assert.deepStrictEqual(withVariablePresentation(own, true).variablePresentation, { protected: 'inline' });
    assert.strictEqual(withVariablePresentation({ type: 'debugpy', request: 'launch', name: 'x' }, false).variablePresentation, undefined);
    assert.deepStrictEqual(withVariablePresentation({ type: '', request: '', name: '' }, true), { type: '', request: '', name: '' }, 'empty config untouched');
    assert.strictEqual(withVariablePresentation({ type: 'node', request: 'launch', name: 'x' }, true).variablePresentation, undefined);
    // bug: configurations with the older type name "python" (also run by debugpy) were not grouped
    assert.deepStrictEqual(withVariablePresentation({ type: 'python', request: 'launch', name: 'x' }, true).variablePresentation, PYCHARM_PRESENTATION);
  });

  test('page: an evaluate result is dropped on the next stop, even at the same frame (bug: it stayed, stale)', async () => {
    const page = runPage();
    const { model } = setup();
    await model.stopped('s1', 1);
    page.send({ type: 'state', state: model.state });
    page.send({ type: 'evaluated', result: { expression: 'speed * 2', result: { name: 'speed * 2', value: '84', type: 'int', ref: 0 } } });
    await tick();
    assert.ok(page.dom.allText().includes('result'), 'shown after Enter');
    await model.stopped('s1', 1); // a step that ends in the same frame id
    page.send({ type: 'state', state: model.state });
    await tick();
    assert.ok(!page.dom.allText().includes('84'));
  });

  test('page: console lines past the 2000 kept still appear (bug: the page missed them)', async () => {
    const page = runPage();
    const { model } = setup();
    for (let i = 0; i < 2000; i++) {
      model.output('s1', 'stdout', `L${i}`);
    }
    page.send({ type: 'state', state: model.state });
    // Two more lines, the last one equal to the previous last line: same count, same last text as before.
    model.output('s1', 'stdout', 'NEW');
    model.output('s1', 'stdout', 'L1999');
    page.send({ type: 'state', state: model.state });
    const out = page.dom.document.getElementById('console-out')!;
    assert.ok(out.text().includes('NEW'));
    assert.strictEqual(out.children.length, 2000);
    assert.strictEqual(out.children[0].text(), 'L2');
  });

  test('panel messages drive the model; children and evaluations are answered to the page', async () => {
    const provider = new DebugPanelProvider();
    const session = new FakeSession();
    provider.model.addSession(session);
    await provider.model.stopped('s1', 1);
    const posted: any[] = [];
    const webview = { postMessage: async (m: any) => { posted.push(m); return true; } } as any;
    await provider.handleMessage({ type: 'children', reqId: 7, id: 's1', ref: 500 }, webview);
    assert.strictEqual(posted[0].reqId, 7);
    assert.strictEqual(posted[0].nodes[0].name, 'odometer');
    await provider.handleMessage({ type: 'evaluate', id: 's1', expression: 'my_car.time' }, webview);
    assert.strictEqual(posted[1].result.result.value, '1');
    await provider.handleMessage({ type: 'addWatch', expression: 'speed' }, webview);
    assert.deepStrictEqual(provider.model.session('s1')!.watches.map((w) => w.expression), ['speed']);
    await provider.handleMessage({ type: 'action', id: 's1', action: 'stepOver' }, webview);
    assert.strictEqual(session.requests.pop()![0], 'next');
    await provider.handleMessage({ type: 'closeSession', id: 's1' }, webview);
    assert.deepStrictEqual(provider.model.state.sessions, []);
    provider.dispose();
  });

  test('Show Execution Point opens the paused line in the editor, with the keyboard there', async function () {
    this.timeout(15000);
    const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-exec-'));
    const car = path.join(dir, 'car.py');
    nodeFs.writeFileSync(car, Array.from({ length: 50 }, (_, i) => `line_${i + 1} = ${i + 1}`).join('\n'));
    const provider = new DebugPanelProvider();
    try {
      assert.strictEqual(await provider.showExecutionPoint(), undefined, 'no program paused: nothing opens');
      const session = new FakeSession();
      session.carPath = car;
      provider.model.addSession(session);
      await provider.model.stopped('s1', 1);
      await provider.model.selectFrame('s1', 11); // the user looked at <module>, line 42
      await window.showTextDocument(await workspace.openTextDocument({ content: 'elsewhere' })); // and went elsewhere
      const editor = await provider.showExecutionPoint();
      assert.ok(editor, 'an editor opened');
      assert.strictEqual(path.normalize(editor!.document.uri.fsPath).toLowerCase(), path.normalize(car).toLowerCase());
      assert.deepStrictEqual([editor!.selection.active.line, editor!.selection.active.character], [14, 8], 'line 15, column 9');
      assert.strictEqual(window.activeTextEditor, editor, 'the keyboard is in that editor');
      assert.strictEqual(provider.model.session('s1')!.frameId, 10, 'the top frame is selected again');
    } finally {
      provider.dispose();
      await commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await commands.executeCommand('workbench.action.closeAllEditors');
      try { nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* temp */ }
    }
  });

  test('Rerun repeats the program as first started, not with ${file} read again from the open editor (bug)', () => {
    // What VS Code hands over as a session's configuration: variables already replaced at the first start.
    const resolved = {
      type: 'debugpy', request: 'launch', name: 'Python: Current File', program: 'C:\\proj\\main.py', cwd: 'C:\\proj',
      noDebug: true, __configurationTarget: 5, debugAdapterPython: 'C:\\py\\python.exe', debugLauncherPython: 'C:\\py\\python.exe',
      charmrunRunId: 'run-1', charmrunLaunchToken: 'tok',
    };
    const plan = planRerun(resolved);
    assert.strictEqual(plan.runId, 'run-1', 'a PyCharm-style Run launch is repeated through its run');
    assert.strictEqual(plan.noDebug, true, 'Run stays Run, Debug stays Debug');
    assert.deepStrictEqual(plan.configuration, {
      type: 'debugpy', request: 'launch', name: 'Python: Current File', program: 'C:\\proj\\main.py', cwd: 'C:\\proj', noDebug: true,
    }, 'the same script path; internal fields left for the new start to fill in');
    assert.strictEqual(planRerun({ type: 'node', request: 'launch', name: 'x' }).runId, undefined);
  });

  test('two quick clicks on Rerun start the program once (bug: it ran twice)', async () => {
    const provider = new DebugPanelProvider();
    const session = Object.assign(new FakeSession('r1', 'junk'), {
      configuration: { type: 'debugpy', request: 'launch', name: 'junk', program: 'C:\\proj\\scripts\\junk.py' },
      workspaceFolder: undefined,
    });
    provider.model.addSession(session);
    await provider.model.stopped('r1', 1);
    // Stopping a paused program takes a moment; the second click lands meanwhile.
    let stopped!: () => void;
    const stopping = new Promise<void>((resolve) => (stopped = resolve));
    const launches: any[] = [];
    Object.assign(provider as any, {
      stop: () => stopping,
      relaunch: async (plan: any) => { launches.push(plan); },
    });
    const webview = { postMessage: async () => true } as any;
    const first = provider.handleMessage({ type: 'action', id: 'r1', action: 'rerun' }, webview);
    const second = provider.handleMessage({ type: 'action', id: 'r1', action: 'rerun' }, webview);
    stopped();
    await Promise.all([first, second]);
    assert.strictEqual(launches.length, 1);
    assert.strictEqual(launches[0].configuration.program, 'C:\\proj\\scripts\\junk.py');
    await provider.handleMessage({ type: 'action', id: 'r1', action: 'rerun' }, webview);
    assert.strictEqual(launches.length, 1, 'a late click on the closed tab does nothing');
    provider.dispose();
  });

  test('Evaluate Expression starts with the selection or the dotted name under the cursor', async () => {
    const editor = await window.showTextDocument(await workspace.openTextDocument({ content: 'total = my_car.speed + 1', language: 'python' }));
    try {
      editor.selection = new Selection(0, 17, 0, 17); // inside "speed"
      assert.strictEqual(expressionAtCursor(editor), 'my_car.speed');
      editor.selection = new Selection(0, 8, 0, 24);
      assert.strictEqual(expressionAtCursor(editor), 'my_car.speed + 1');
      editor.selection = new Selection(0, 6, 0, 6); // on "="
      assert.strictEqual(expressionAtCursor(editor), '');
    } finally {
      await commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });

  test('Evaluate Expression evaluates in the selected frame and puts "result" at the top of the variables', async () => {
    const provider = new DebugPanelProvider();
    const original = window.showInputBox;
    let offered: string | undefined;
    Object.assign(window, { showInputBox: async (o: { value?: string }) => { offered = o.value; return 'my_car.time'; } });
    try {
      assert.strictEqual(await provider.evaluateExpression(), undefined, 'nothing paused: no question asked');
      assert.strictEqual(offered, undefined);
      const session = new FakeSession();
      provider.model.addSession(session);
      await provider.model.stopped('s1', 1);
      const result = await provider.evaluateExpression();
      assert.strictEqual(result?.result?.value, '1');
      assert.deepStrictEqual(session.requests.filter(([c]) => c === 'evaluate').pop()![1], { expression: 'my_car.time', frameId: 10, context: 'watch' });
    } finally {
      Object.assign(window, { showInputBox: original });
      provider.dispose();
    }
  });

  test('Run to Cursor continues to the editor\'s cursor line, only while paused', async () => {
    const provider = new DebugPanelProvider();
    const ran: string[] = [];
    const original = commands.executeCommand;
    Object.assign(commands, { executeCommand: async (id: string, ...rest: any[]) => { ran.push(id); return id === 'editor.debug.action.runToCursor' ? undefined : original(id, ...rest); } });
    try {
      await provider.runToCursor();
      assert.ok(!ran.includes('editor.debug.action.runToCursor'), 'not while nothing is paused');
      provider.model.addSession(new FakeSession());
      await provider.model.stopped('s1', 1);
      await window.showTextDocument(await workspace.openTextDocument({ content: 'a = 1\nb = 2\n', language: 'python' }));
      await provider.runToCursor();
      assert.ok(ran.includes('editor.debug.action.runToCursor'));
    } finally {
      Object.assign(commands, { executeCommand: original });
      await commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      provider.dispose();
    }
  });

  test('page: the toolbar has PyCharm\'s step buttons in order, usable only while paused', async () => {
    const html = getDebugPanelHtml('vscode-webview:', 'N');
    const order = [...html.matchAll(/<button class="tool[^"]*" data-action="(\w+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(order, ['rerun', 'stop', 'resume', 'pause', 'showExecutionPoint', 'stepOver', 'stepInto',
      'stepIntoMyCode', 'stepOut', 'runToCursor', 'evaluateExpression', 'viewBreakpoints', 'muteBreakpoints']);
    const page = runPage();
    const { model } = setup();
    model.continued('s1');
    page.send({ type: 'state', state: model.state });
    const buttons = ['stepIntoMyCode', 'runToCursor', 'evaluateExpression'].map((a) => page.dom.find((e) => e.dataset.action === a)!);
    assert.ok(buttons.every((b) => b.disabled), 'disabled while running');
    await model.stopped('s1', 1);
    page.send({ type: 'state', state: model.state });
    assert.ok(buttons.every((b) => !b.disabled), 'enabled while paused');
    buttons[0].click();
    assert.deepStrictEqual(page.sent[page.sent.length - 1], { type: 'action', id: 's1', action: 'stepIntoMyCode' });
  });

  test('page: the Show Execution Point button sits before Step Over and works only while paused', async () => {
    const html = getDebugPanelHtml('vscode-webview:', 'N');
    assert.ok(html.indexOf('data-action="showExecutionPoint"') < html.indexOf('data-action="stepOver"'));
    const page = runPage();
    const { model } = setup();
    model.continued('s1');
    page.send({ type: 'state', state: model.state });
    const button = page.dom.find((e) => e.dataset.action === 'showExecutionPoint')!;
    assert.strictEqual(button.disabled, true, 'disabled while running');
    await model.stopped('s1', 1);
    page.send({ type: 'state', state: model.state });
    assert.strictEqual(button.disabled, false, 'enabled while paused');
    button.click();
    assert.deepStrictEqual(page.sent[page.sent.length - 1], { type: 'action', id: 's1', action: 'showExecutionPoint' });
  });

  test('Alt+F10 is free for Show Execution Point (no VS Code default uses it while debugging)', async () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const key = pkg.keybindings.find((k: { command: string }) => k.command === 'aspycharm.debug.showExecutionPoint');
    assert.deepStrictEqual([key?.key, key?.when], ['alt+f10', "inDebugMode && debugState == 'stopped'"]);
    await commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    const text = window.activeTextEditor?.document.getText() ?? '';
    await commands.executeCommand('workbench.action.closeActiveEditor');
    assert.ok(text.includes('"key"'), 'read the default keybindings');
    // Known, accepted overlap: "Go to Next Comment Thread" (only in editors with review comments, e.g. a pull
    // request). While a program is paused there, Alt+F10 shows the execution point, as in PyCharm.
    const known = /"command":\s*"editor\.action\.nextCommentedRangeAction"[\s\S]*"when":\s*"activeEditorHasCommentingRange"/;
    const others = [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0])
      .filter((e) => /"key":\s*"alt\+f10"/.test(e) && !/"command":\s*"(aspycharm\.|-)/.test(e) && !known.test(e));
    assert.deepStrictEqual(others, [], 'alt+f10 is not used by another command');
    assert.ok((await commands.getCommands(true)).includes('aspycharm.debug.showExecutionPoint'));
  });

  test('PyCharm\'s keys for Step Into My Code, Run to Cursor and Evaluate Expression: only known overlaps', async () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const ours: Record<string, string> = {
      'aspycharm.debug.stepIntoMyCode': 'alt+shift+f7',
      'aspycharm.debug.runToCursor': 'alt+f9',
      'aspycharm.debug.evaluateExpression': 'alt+f8',
    };
    for (const [command, key] of Object.entries(ours)) {
      const k = pkg.keybindings.find((b: { command: string }) => b.command === command);
      assert.deepStrictEqual([k?.key, k?.when], [key, "inDebugMode && debugState == 'stopped'"], command);
      assert.ok((await commands.getCommands(true)).includes(command), `${command} registered`);
    }
    await commands.executeCommand('workbench.action.openDefaultKeybindingsFile');
    const text = window.activeTextEditor?.document.getText() ?? '';
    await commands.executeCommand('workbench.action.closeActiveEditor');
    // Known, accepted overlaps: ours apply only while a program is paused in the debugger (then they win, as in
    // PyCharm); the rest of the time these keep working as in VS Code. Documented in the README.
    const known: Record<string, string[]> = {
      'alt+f8': ['editor.action.marker.next', 'testing.goToNextMessage'],
      'alt+f9': ['editor.action.nextCommentThreadAction', 'testing.coverage.goToNextMissedLine'],
      'alt+shift+f7': [],
    };
    const users = (key: string) => [...text.matchAll(/\{[^{}]*\}/g)].map((m) => m[0].replace(/\s+/g, ' '))
      .filter((e) => e.includes(`"key": "${key}"`) && !/"command": "(aspycharm\.|-)/.test(e))
      .map((e) => /"command": "([^"]+)"/.exec(e)![1]);
    for (const key of Object.values(ours)) {
      assert.deepStrictEqual(users(key).filter((c) => !known[key].includes(c)), [], `${key}: a new clash`);
    }
  });

  test('contributed: a Debug tab in the bottom panel, frame commands with Ctrl+Alt+Up/Down, settings', async () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    assert.ok(pkg.viewsContainers.panel.some((c: { id: string }) => c.id === 'aspycharmDebug'));
    assert.deepStrictEqual(pkg.views.aspycharmDebug[0], { type: 'webview', id: 'aspycharm.debugPanel', name: 'Debug' });
    const keys = pkg.keybindings.filter((k: { command: string }) => k.command.startsWith('aspycharm.debug.frame')).map((k: { key: string }) => k.key);
    assert.deepStrictEqual(keys, ['ctrl+alt+up', 'ctrl+alt+down']);
    const description: string = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.description;
    assert.ok(!description.includes('), +'), 'description reads cleanly');
    const settings = pkg.configuration.flatMap((c: { properties: object }) => Object.keys(c.properties));
    assert.ok(settings.includes('aspycharm.debug.showPanelOnBreakpoint') && settings.includes('aspycharm.debug.groupAttributes'));
    const all = await commands.getCommands(true);
    for (const id of ['aspycharm.debug.frameUp', 'aspycharm.debug.frameDown', 'aspycharm.debug.showPanel', 'aspycharm.debugPanel.focus']) {
      assert.ok(all.includes(id), id);
    }
  });

  test('the panel opens and its page loads', async () => {
    await commands.executeCommand('aspycharm.debug.showPanel');
    await commands.executeCommand('aspycharm.debugPanel.focus');
    await commands.executeCommand('workbench.action.closePanel');
  });
});
