// The PyCharm-style Debug panel page. Values from the debugged program are untrusted: the script only ever sets
// them with textContent (never innerHTML), and the page may only run its own nonce'd script.

const ICONS: Record<string, string> = {
  rerun: '<path d="M13 8a5 5 0 1 1-1.5-3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12.8 1.8v3.4H9.4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  stop: '<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  resume: '<path d="M3 3v10" stroke="currentColor" stroke-width="1.6"/><path d="M6 3l7 5-7 5z" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  pause: '<path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="1.8"/>',
  stepOver: '<path d="M2.5 9a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M13.8 5.6v3.6h-3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.4"/>',
  stepInto: '<path d="M8 2v8M4.5 6.8 8 10.3l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 13.5h12" stroke="currentColor" stroke-width="1.4"/>',
  stepOut: '<path d="M8 11V3M4.5 6.2 8 2.7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2 13.5h12" stroke="currentColor" stroke-width="1.4"/>',
  viewBreakpoints: '<circle cx="6" cy="9" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="7" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  muteBreakpoints: '<circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13 13 3" stroke="currentColor" stroke-width="1.4"/>',
};

const TOOLBAR: [string, string, string][] = [
  ['rerun', 'Rerun (Ctrl+Shift+F5)', 'rerun'],
  ['stop', 'Stop (Shift+F5)', 'stop'],
  ['|', '', ''],
  ['resume', 'Resume Program (F5)', 'go'],
  ['pause', 'Pause Program (F6)', 'go'],
  ['|', '', ''],
  ['stepOver', 'Step Over (F10)', 'step'],
  ['stepInto', 'Step Into (F11)', 'step'],
  ['stepOut', 'Step Out (Shift+F11)', 'step'],
  ['|', '', ''],
  ['viewBreakpoints', 'View Breakpoints', 'bp'],
  ['muteBreakpoints', 'Mute Breakpoints', 'bp'],
];

export function getDebugPanelHtml(cspSource: string, nonce: string): string {
  const toolbar = TOOLBAR.map(([id, title, cls]) => (id === '|'
    ? '<span class="sep"></span>'
    : `<button class="tool ${cls}" data-action="${id}" title="${title}" aria-label="${title}"><svg viewBox="0 0 16 16" width="16" height="16">${ICONS[id]}</svg></button>`)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Debug</title>
<style nonce="${nonce}">
  :root { --row: 22px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-panel-background);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
  .tabs, .bar { display: flex; align-items: center; border-bottom: 1px solid var(--vscode-panel-border, transparent); min-height: 32px; padding: 0 8px; gap: 2px; flex-shrink: 0; }
  .title { font-weight: 600; margin-right: 12px; }
  .stab, .vtab { padding: 6px 10px; border-bottom: 2px solid transparent; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .stab.active, .vtab.active { border-bottom-color: var(--vscode-focusBorder); }
  .stab .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-debugIcon-continueForeground, #89d185); }
  .stab.running .dot { background: var(--vscode-debugIcon-startForeground, #89d185); }
  .stab.stopped .dot { background: var(--vscode-debugIcon-pauseForeground, #75beff); }
  .stab.ended .dot { background: var(--vscode-disabledForeground, #888); }
  .stab .close { opacity: .6; padding: 0 2px; }
  .stab .close:hover { opacity: 1; }
  .toolbar { display: flex; align-items: center; gap: 2px; margin-left: 12px; }
  .tool { width: 26px; height: 24px; display: grid; place-items: center; border-radius: 4px; }
  .tool:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
  .tool:disabled { opacity: .35; cursor: default; }
  .tool.rerun { color: var(--vscode-debugIcon-restartForeground, #89d185); }
  .tool[data-action="stop"] { color: var(--vscode-debugIcon-stopForeground, #f48771); }
  .tool.go { color: var(--vscode-debugIcon-continueForeground, #75beff); }
  .tool.step { color: var(--vscode-debugIcon-stepOverForeground, #75beff); }
  .tool.bp { color: var(--vscode-debugIcon-breakpointForeground, #e51400); }
  .tool.muted { background: var(--vscode-inputOption-activeBackground); }
  .sep { width: 1px; height: 18px; background: var(--vscode-panel-border, #555); margin: 0 4px; }
  .pane { flex: 1; min-height: 0; display: none; }
  .pane.shown { display: flex; }
  #variables-pane { flex-direction: row; }
  .frames { width: 34%; min-width: 180px; max-width: 420px; border-right: 1px solid var(--vscode-panel-border, transparent); display: flex; flex-direction: column; }
  .frames select { margin: 6px 8px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); padding: 3px; }
  #frame-list { flex: 1; overflow: auto; }
  .frame { padding: 2px 10px; height: var(--row); line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
  .frame:hover { background: var(--vscode-list-hoverBackground); }
  .frame.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .frame .where { opacity: .75; }
  .hint { padding: 6px 10px; font-size: 90%; opacity: .7; border-top: 1px solid var(--vscode-panel-border, transparent); }
  .vars { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  input.line { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent);
               font-family: var(--vscode-editor-font-family); padding: 4px 8px; margin: 6px 8px; outline: none; }
  input.line:focus { border-color: var(--vscode-focusBorder); }
  #tree, #console-out { flex: 1; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
  .row { height: var(--row); line-height: var(--row); white-space: nowrap; display: flex; align-items: center; padding-right: 8px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .twisty { width: 16px; text-align: center; flex-shrink: 0; opacity: .8; cursor: pointer; }
  .badge { font-size: 8px; line-height: 8px; width: 14px; margin-right: 6px; text-align: center; opacity: .8; flex-shrink: 0; white-space: pre; }
  .badge.obj { color: var(--vscode-debugTokenExpression-name, #c586c0); font-size: 13px; }
  .name { color: var(--vscode-debugTokenExpression-name, #c586c0); }
  .row.watch .name, .row.result .name { color: var(--vscode-textLink-foreground, #3794ff); }
  .row.group .name { color: var(--vscode-foreground); }
  .eq { opacity: .8; }
  .type { color: var(--vscode-descriptionForeground); margin-right: 4px; }
  .value { overflow: hidden; text-overflow: ellipsis; }
  .value.string { color: var(--vscode-debugTokenExpression-string, #ce9178); }
  .value.number { color: var(--vscode-debugTokenExpression-number, #b5cea8); }
  .value.error, .c-error, .c-stderr { color: var(--vscode-debugTokenExpression-error, #f48771); }
  .remove { margin-left: auto; opacity: 0; padding: 0 4px; }
  .row:hover .remove { opacity: .7; }
  .message { padding: 10px 12px; opacity: .75; }
  #console-pane { flex-direction: column; }
  #console-out { padding: 4px 10px; white-space: pre-wrap; word-break: break-all; }
  .c-input { color: var(--vscode-textLink-foreground, #3794ff); }
  .c-console { opacity: .75; }
  #empty { padding: 16px; opacity: .75; display: none; }
  body.no-session #empty { display: block; }
  body.no-session .bar, body.no-session .pane { display: none !important; }
</style>
</head>
<body class="no-session">
  <div class="tabs" id="tabs"><span class="title">Debug</span></div>
  <div class="bar">
    <button class="vtab active" data-tab="variables">Threads &amp; Variables</button>
    <button class="vtab" data-tab="console">Console</button>
    <div class="toolbar">${toolbar}</div>
  </div>
  <div class="pane shown" id="variables-pane">
    <div class="frames">
      <select id="thread" aria-label="Thread"></select>
      <div id="frame-list" role="listbox" aria-label="Frames"></div>
      <div class="hint">Switch frames from anywhere with Ctrl+Alt+↑ / Ctrl+Alt+↓</div>
    </div>
    <div class="vars">
      <input class="line" id="eval" placeholder="Evaluate expression (Enter) or add a watch (Ctrl+Shift+Enter)" spellcheck="false">
      <div id="tree" role="tree"></div>
    </div>
  </div>
  <div class="pane" id="console-pane">
    <div id="console-out"></div>
    <input class="line" id="console-in" placeholder=">>> run Python in the selected frame (Enter)" spellcheck="false">
  </div>
  <div id="empty">No debug session. Start one with Run &gt; Start Debugging (F5), or CharmRun's Debug button.</div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let tab = saved.tab || 'variables';
  let expanded = new Set(saved.expanded || []);
  let state = { sessions: [] };
  let lastTreeKey = '';
  let evalResult = null;
  let evalWhere = '';
  let reqId = 0;
  const pending = new Map();

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const active = () => state.sessions.find((s) => s.id === state.activeId);
  const save = () => vscode.setState({ tab: tab, expanded: Array.from(expanded) });

  function children(sessionId, ref) {
    return new Promise((resolve) => { const id = ++reqId; pending.set(id, resolve); vscode.postMessage({ type: 'children', reqId: id, id: sessionId, ref: ref }); });
  }

  // --- session tabs ---
  function renderTabs() {
    const tabs = $('tabs');
    while (tabs.children.length > 1) tabs.removeChild(tabs.lastChild);
    state.sessions.forEach((s) => {
      const t = el('div', 'stab ' + s.state + (s.id === state.activeId ? ' active' : ''));
      t.title = s.name + ' (' + s.state + ')';
      t.appendChild(el('span', 'dot'));
      const name = el('span', '', s.name);
      t.appendChild(name);
      const close = el('button', 'close', '×');
      close.title = s.state === 'ended' ? 'Close' : 'Stop and close';
      close.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'closeSession', id: s.id }); });
      t.appendChild(close);
      t.addEventListener('click', () => vscode.postMessage({ type: 'selectSession', id: s.id }));
      tabs.appendChild(t);
    });
    document.body.classList.toggle('no-session', state.sessions.length === 0);
  }

  // --- toolbar ---
  function renderToolbar() {
    const s = active();
    const st = s ? s.state : 'ended';
    document.querySelectorAll('.tool').forEach((b) => {
      const a = b.dataset.action;
      b.disabled = !s || (a === 'pause' ? st !== 'running' : ['resume', 'stepOver', 'stepInto', 'stepOut'].includes(a) ? st !== 'stopped' : a === 'stop' ? st === 'ended' : false);
      if (a === 'muteBreakpoints') b.classList.toggle('muted', Boolean(state.breakpointsMuted));
    });
  }

  // --- frames ---
  function renderFrames() {
    const s = active();
    const select = $('thread');
    select.textContent = '';
    const list = $('frame-list');
    list.textContent = '';
    if (!s) return;
    s.threads.forEach((t) => { const o = el('option', '', t.name); o.value = String(t.id); o.selected = t.id === s.threadId; select.appendChild(o); });
    select.disabled = s.threads.length < 2;
    if (s.state !== 'stopped') {
      list.appendChild(el('div', 'message', s.state === 'running' ? 'The application is running' : 'The session has ended'));
      return;
    }
    s.frames.forEach((f) => {
      const row = el('div', 'frame' + (f.id === s.frameId ? ' selected' : ''));
      row.setAttribute('role', 'option');
      row.appendChild(el('span', '', f.name));
      if (f.file) row.appendChild(el('span', 'where', ', ' + f.file + ':' + f.line));
      row.title = (f.path || f.file || '') + ':' + f.line;
      row.addEventListener('click', () => vscode.postMessage({ type: 'selectFrame', id: s.id, frameId: f.id }));
      list.appendChild(row);
    });
  }

  // --- variables tree ---
  function valueClass(node) {
    if (/^(int|float|complex|bool|decimal|Decimal)$/.test(node.type || '')) return 'value number';
    if (/^(str|bytes)$/.test(node.type || '')) return 'value string';
    return 'value';
  }

  function nodeRow(node, depth, kind, key, onRemove) {
    const row = el('div', 'row ' + kind + (node.group ? ' group' : ''));
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = (6 + depth * 16) + 'px';
    const open = expanded.has(key);
    const twisty = el('span', 'twisty', node.ref > 0 ? (open ? '▾' : '▸') : '');
    row.appendChild(twisty);
    row.appendChild(el('span', node.ref > 0 && !node.group ? 'badge obj' : 'badge', node.group ? '⚿' : node.ref > 0 ? '≡' : '10\\n01'));
    row.appendChild(el('span', 'name', node.name));
    if (!node.group) {
      row.appendChild(el('span', 'eq', ' = '));
      if (node.type) row.appendChild(el('span', 'type', '{' + node.type + '}'));
      row.appendChild(el('span', node.error ? 'value error' : valueClass(node), node.error || node.value));
    }
    if (onRemove) { const x = el('button', 'remove', '×'); x.title = 'Remove watch'; x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); }); row.appendChild(x); }
    row.title = node.name + (node.type ? ' {' + node.type + '}' : '') + (node.group ? '' : ' = ' + (node.error || node.value));
    if (node.ref > 0) {
      row.addEventListener('click', () => { if (expanded.has(key)) expanded.delete(key); else expanded.add(key); save(); lastTreeKey = ''; renderTree(); });
    }
    return row;
  }

  async function appendNode(container, sessionId, node, depth, kind, key, onRemove) {
    container.appendChild(nodeRow(node, depth, kind, key, onRemove));
    if (node.ref > 0 && expanded.has(key)) {
      const kids = await children(sessionId, node.ref);
      for (const kid of kids) await appendNode(container, sessionId, kid, depth + 1, 'var', key + '/' + kid.name);
    }
  }

  async function renderTree() {
    const s = active();
    const key = JSON.stringify(s ? [s.id, s.state, s.frameId, s.variables, s.scopes, s.watches, evalResult] : null) + '|' + Array.from(expanded).join(',');
    if (key === lastTreeKey) return;
    lastTreeKey = key;
    const tree = $('tree');
    const fresh = el('div');
    if (s && s.state === 'stopped') {
      const base = s.id + ':';
      if (evalResult) await appendNode(fresh, s.id, evalResult.result ? Object.assign({}, evalResult.result, { name: 'result' }) : { name: 'result', value: '', error: evalResult.error, ref: 0 }, 0, 'result', base + 'r');
      for (const w of s.watches) {
        const node = w.result ? Object.assign({}, w.result, { name: w.expression }) : { name: w.expression, value: '', error: w.error || '', ref: 0 };
        await appendNode(fresh, s.id, node, 0, 'watch', base + 'w/' + w.expression, () => vscode.postMessage({ type: 'removeWatch', expression: w.expression }));
      }
      for (const v of s.variables) await appendNode(fresh, s.id, v, 0, 'var', base + 'v/' + v.name);
      for (const g of s.scopes) await appendNode(fresh, s.id, g, 0, 'var', base + 's/' + g.name);
      if (!s.variables.length && !s.scopes.length && !s.watches.length) fresh.appendChild(el('div', 'message', 'No variables in this frame'));
    } else if (s) {
      fresh.appendChild(el('div', 'message', s.state === 'running' ? 'The application is running' : 'The session has ended'));
    }
    if (key !== lastTreeKey) return; // a newer state arrived while children were loading
    tree.replaceChildren(...fresh.childNodes);
  }

  // --- console ---
  // Appends only the lines written since the last update (consoleTotal counts every line ever written;
  // the session keeps the last 2000). Redraws when switching sessions or when more lines came than are kept.
  let consoleShown = { id: '', total: 0 };
  function renderConsole() {
    const s = active();
    $('console-in').disabled = !s || s.state !== 'stopped';
    const out = $('console-out');
    const lines = s ? s.console : [];
    const total = s ? s.consoleTotal : 0;
    const id = s ? s.id : '';
    if (id === consoleShown.id && total === consoleShown.total) return;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    const fresh = total - consoleShown.total;
    let start = 0;
    if (id === consoleShown.id && fresh > 0 && fresh <= lines.length) {
      start = lines.length - fresh;
    } else {
      out.textContent = '';
    }
    for (let i = start; i < lines.length; i++) {
      out.appendChild(el('div', 'c-' + lines[i].category, lines[i].text.replace(/\\n$/, '')));
    }
    while (out.children.length > lines.length) out.removeChild(out.children[0]);
    consoleShown = { id: id, total: total };
    if (atBottom) out.scrollTop = out.scrollHeight;
  }

  function showTab(name) {
    tab = name;
    save();
    document.querySelectorAll('.vtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('variables-pane').classList.toggle('shown', name === 'variables');
    $('console-pane').classList.toggle('shown', name === 'console');
  }

  function render() {
    renderTabs();
    renderToolbar();
    renderFrames();
    void renderTree();
    renderConsole();
  }

  // --- events ---
  document.querySelectorAll('.vtab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => { const s = active(); vscode.postMessage({ type: 'action', id: s && s.id, action: b.dataset.action }); }));
  $('thread').addEventListener('change', (e) => { const s = active(); if (s) vscode.postMessage({ type: 'selectThread', id: s.id, threadId: Number(e.target.value) }); });
  $('eval').addEventListener('keydown', (e) => {
    const s = active();
    const text = e.target.value.trim();
    if (e.key !== 'Enter' || !text || !s) return;
    if (e.ctrlKey && e.shiftKey) { vscode.postMessage({ type: 'addWatch', expression: text }); e.target.value = ''; }
    else vscode.postMessage({ type: 'evaluate', id: s.id, expression: text });
  });
  $('console-in').addEventListener('keydown', (e) => {
    const s = active();
    const text = e.target.value;
    if (e.key !== 'Enter' || !text.trim() || !s) return;
    vscode.postMessage({ type: 'console', id: s.id, text: text });
    e.target.value = '';
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      state = msg.state;
      const s = active();
      // An evaluate result belongs to the frame it was computed in: drop it on a step, a frame or session change.
      const where = s ? s.id + ':' + s.state + ':' + s.stops + ':' + s.frameId : '';
      if (where !== evalWhere) evalResult = null;
      evalWhere = where;
      render();
    } else if (msg.type === 'children') {
      const resolve = pending.get(msg.reqId);
      pending.delete(msg.reqId);
      if (resolve) resolve(msg.nodes || []);
    } else if (msg.type === 'evaluated') {
      evalResult = msg.result;
      lastTreeKey = '';
      void renderTree();
    } else if (msg.type === 'showTab') {
      showTab(msg.tab);
    }
  });

  showTab(tab);
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

export function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
