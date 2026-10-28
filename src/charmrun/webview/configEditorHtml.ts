import * as vscode from 'vscode';
import { RunConfiguration } from '../types';
import { formatArgs, parseArgs } from './argsText';

export interface EditorContext {
  /** Other CharmRun configurations that a before-launch step can run. */
  availableConfigs: { id: string; name: string }[];
  /** Task labels available in the workspace. */
  availableTasks: string[];
}

export function getEditorHtml(
  webview: vscode.Webview,
  config: RunConfiguration,
  nonce: string,
  context: EditorContext
): string {
  const configJson = toScriptJson(config);
  const availableConfigsJson = toScriptJson(context.availableConfigs);
  const availableTasksJson = toScriptJson(context.availableTasks);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Edit Run Configuration</title>
  <style nonce="${nonce}">
    :root {
      --spacing: 8px;
    }
    body {
      padding: 16px 24px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      max-width: 700px;
      margin: 0 auto;
    }
    h2 {
      margin: 0 0 16px 0;
      font-weight: 600;
      font-size: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 8px;
    }
    .form-group {
      margin-bottom: 12px;
    }
    .form-group label {
      display: block;
      margin-bottom: 4px;
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    input, select, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 2px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      outline: none;
    }
    input:focus, select:focus, textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    select {
      appearance: auto;
    }
    .form-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    .form-row .field {
      flex: 1;
    }
    .browse-btn, .add-btn, .remove-btn {
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      white-space: nowrap;
    }
    .browse-btn:hover, .add-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .remove-btn {
      padding: 6px 8px;
      color: var(--vscode-errorForeground);
    }
    .env-section {
      margin-top: 4px;
    }
    .env-row {
      display: flex;
      gap: 8px;
      margin-bottom: 6px;
      align-items: center;
    }
    .env-row input {
      flex: 1;
    }
    .env-row .env-key {
      flex: 0 0 35%;
    }
    .button-bar {
      margin-top: 20px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 16px;
    }
    .primary-btn {
      padding: 6px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
    }
    .primary-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .secondary-btn {
      padding: 6px 16px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
    }
    .secondary-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .apply-status {
      margin-right: auto;
      align-self: center;
      font-size: var(--vscode-font-size);
      color: var(--vscode-descriptionForeground);
      opacity: 0;
      transition: opacity 150ms ease-in;
    }
    .apply-status.visible {
      opacity: 1;
    }
    .hidden {
      display: none;
    }
    .checkbox-row {
      display: flex !important;
      align-items: center;
      gap: 6px;
      text-transform: none !important;
      font-weight: normal !important;
      cursor: pointer;
    }
    .checkbox-row input[type="checkbox"] {
      width: auto;
      margin: 0;
    }
    .prerun-row {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
      border-radius: 2px;
      padding: 8px;
      margin-bottom: 8px;
    }
    .prerun-head {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .prerun-head select {
      flex: 1;
    }
    .prerun-head input[type="checkbox"] {
      width: auto;
      margin: 0;
    }
    .prerun-fields {
      margin-top: 8px;
    }
    .prerun-fields label {
      display: block;
      margin: 6px 0 4px 0;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    .prerun-empty {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .icon-btn {
      padding: 4px 8px;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    }
    .icon-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .section-label {
      font-size: 13px;
      font-weight: 600;
      margin-top: 16px;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    .args-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .args-row input {
      flex: 1;
    }
    .expand-btn {
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 2px;
      cursor: pointer;
      font-size: var(--vscode-font-size);
      white-space: nowrap;
    }
    .expand-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal-overlay.hidden {
      display: none;
    }
    .modal {
      width: min(640px, calc(100vw - 48px));
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #ffffff));
      color: var(--vscode-editorWidget-foreground, var(--vscode-foreground, #333333));
      border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      border-radius: 4px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      padding: 16px;
      box-sizing: border-box;
    }
    .modal h3 {
      margin: 0 0 8px 0;
      font-size: 14px;
      font-weight: 600;
    }
    .modal-hint {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .modal textarea {
      min-height: 180px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, var(--vscode-font-size));
      white-space: pre-wrap;
    }
    .modal .button-bar {
      margin-top: 12px;
      padding-top: 12px;
    }
  </style>
</head>
<body>
  <h2>Run Configuration</h2>

  <div class="form-group">
    <label for="name">Name</label>
    <input type="text" id="name" placeholder="e.g. Run API Server" />
  </div>

  <div class="form-group">
    <label for="runType">Run Type</label>
    <select id="runType">
      <option value="script">Script</option>
      <option value="module">Module</option>
    </select>
  </div>

  <div class="form-group" id="script-group">
    <label for="script">Script Path</label>
    <div class="form-row">
      <div class="field">
        <input type="text" id="script" placeholder="e.g. src/main.py" />
      </div>
      <button class="browse-btn" id="browse-script">Browse</button>
    </div>
  </div>

  <div class="form-group hidden" id="module-group">
    <label for="module">Module Name</label>
    <input type="text" id="module" placeholder="e.g. uvicorn, pytest" />
  </div>

  <div class="form-group">
    <label for="interpreter">Python Interpreter</label>
    <select id="interpreter-select">
      <option value="selected">Use Selected Interpreter</option>
      <option value="custom">Custom Path</option>
    </select>
  </div>

  <div class="form-group hidden" id="interpreter-path-group">
    <label for="interpreter-path">Interpreter Path</label>
    <div class="form-row">
      <div class="field">
        <input type="text" id="interpreter-path" placeholder="e.g. /usr/bin/python3" />
      </div>
      <button class="browse-btn" id="browse-interpreter">Browse</button>
    </div>
  </div>

  <div class="form-group">
    <label for="args">Arguments</label>
    <div class="args-row">
      <input type="text" id="args" placeholder="e.g. --port 8000 --reload" />
      <button class="expand-btn" id="expand-args" title="Open multi-line editor">Edit...</button>
    </div>
  </div>

  <div class="form-group">
    <label for="cwd">Working Directory</label>
    <div class="form-row">
      <div class="field">
        <input type="text" id="cwd" placeholder="\${workspaceFolder}" />
      </div>
      <button class="browse-btn" id="browse-cwd">Browse</button>
    </div>
  </div>

  <div class="form-group">
    <div class="section-label">Environment Variables</div>
    <div id="env-container" class="env-section"></div>
    <button class="add-btn" id="add-env">+ Add Variable</button>
  </div>

  <div class="form-group">
    <label for="envFile">Env File</label>
    <div class="form-row">
      <div class="field">
        <input type="text" id="envFile" placeholder="e.g. \${workspaceFolder}/.env" />
      </div>
      <button class="browse-btn" id="browse-env-file">Browse</button>
    </div>
  </div>

  <div class="form-group">
    <label for="terminal">Terminal</label>
    <select id="terminal">
      <option value="integrated">Integrated Terminal</option>
      <option value="external">External Terminal</option>
      <option value="internalConsole">Internal Debug Console</option>
    </select>
  </div>

  <div class="form-group">
    <label class="checkbox-row" for="saveOutputToFile">
      <input type="checkbox" id="saveOutputToFile" />
      Save console output to file
    </label>
  </div>

  <div class="form-group hidden" id="output-file-group">
    <label for="outputFile">Output File</label>
    <div class="form-row">
      <div class="field">
        <input type="text" id="outputFile" placeholder="e.g. \${workspaceFolder}/logs/run.log" />
      </div>
      <button class="browse-btn" id="browse-output-file">Browse</button>
    </div>
  </div>

  <div class="form-group">
    <label for="runMode">Default Run Mode</label>
    <select id="runMode">
      <option value="run">Run</option>
      <option value="debug">Debug</option>
    </select>
  </div>

  <div class="form-group">
    <div class="section-label">Before Launch</div>
    <div id="prerun-container"></div>
    <div class="form-row">
      <div class="field">
        <select id="prerun-type">
          <option value="configuration">Run another configuration</option>
          <option value="externalTool">Run external tool</option>
          <option value="task">Run task</option>
        </select>
      </div>
      <button class="add-btn" id="add-prerun">+ Add Step</button>
    </div>
  </div>

  <div class="button-bar">
    <span class="apply-status" id="apply-status" role="status" aria-live="polite"></span>
    <button class="secondary-btn" id="debug-btn">Debug</button>
    <button class="secondary-btn" id="run-btn">Run</button>
    <button class="secondary-btn" id="cancel-btn">Cancel</button>
    <button class="secondary-btn" id="apply-btn">Apply</button>
    <button class="primary-btn" id="save-btn">Save &amp; Close</button>
  </div>

  <div class="modal-overlay hidden" id="multiline-overlay">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="multiline-title">
      <h3 id="multiline-title">Arguments</h3>
      <p class="modal-hint">One argument per line is fine. Line breaks are replaced with spaces when you click OK.</p>
      <textarea id="multiline-textarea" spellcheck="false"></textarea>
      <div class="button-bar">
        <button class="secondary-btn" id="multiline-cancel">Cancel</button>
        <button class="primary-btn" id="multiline-ok">OK</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      const initialConfig = ${configJson};
      const availableConfigs = ${availableConfigsJson};
      const availableTasks = ${availableTasksJson};
      let preRunSteps = [];

      // Elements
      const nameEl = document.getElementById('name');
      const runTypeEl = document.getElementById('runType');
      const scriptGroupEl = document.getElementById('script-group');
      const moduleGroupEl = document.getElementById('module-group');
      const scriptEl = document.getElementById('script');
      const moduleEl = document.getElementById('module');
      const interpreterSelectEl = document.getElementById('interpreter-select');
      const interpreterPathGroupEl = document.getElementById('interpreter-path-group');
      const interpreterPathEl = document.getElementById('interpreter-path');
      const argsEl = document.getElementById('args');
      const cwdEl = document.getElementById('cwd');
      const terminalEl = document.getElementById('terminal');
      const runModeEl = document.getElementById('runMode');
      const envContainer = document.getElementById('env-container');
      const envFileEl = document.getElementById('envFile');
      const saveOutputToFileEl = document.getElementById('saveOutputToFile');
      const outputFileGroupEl = document.getElementById('output-file-group');
      const outputFileEl = document.getElementById('outputFile');
      const preRunContainer = document.getElementById('prerun-container');
      const preRunTypeEl = document.getElementById('prerun-type');

      function populateForm(config) {
        nameEl.value = config.name || '';
        runTypeEl.value = config.runType || 'script';
        scriptEl.value = config.script || '';
        moduleEl.value = config.module || '';
        argsEl.value = formatArgs(config.args || []);
        cwdEl.value = config.cwd || '\${workspaceFolder}';
        envFileEl.value = config.envFile || '';
        terminalEl.value = config.terminal || 'integrated';
        runModeEl.value = config.runMode || 'run';
        saveOutputToFileEl.checked = config.saveOutputToFile === true;
        outputFileEl.value = config.outputFile || '';
        toggleOutputFile();

        if (config.interpreter && config.interpreter !== 'selected') {
          interpreterSelectEl.value = 'custom';
          interpreterPathEl.value = config.interpreter;
        } else {
          interpreterSelectEl.value = 'selected';
          interpreterPathEl.value = '';
        }

        toggleRunType();
        toggleInterpreter();

        preRunSteps = (config.preRun || []).map(step => ({
          id: step.id,
          type: step.type,
          enabled: step.enabled !== false,
          configId: step.configId || '',
          command: step.command || '',
          argsText: formatArgs(step.args || []),
          cwd: step.cwd || '',
          task: step.task || '',
        }));
        renderPreRun();

        envContainer.innerHTML = '';
        const env = config.env || {};
        const entries = Object.entries(env);
        if (entries.length === 0) {
          addEnvRow('', '');
        } else {
          entries.forEach(([key, value]) => addEnvRow(key, value));
        }
      }

      function toggleRunType() {
        const isScript = runTypeEl.value === 'script';
        scriptGroupEl.classList.toggle('hidden', !isScript);
        moduleGroupEl.classList.toggle('hidden', isScript);
      }

      function toggleInterpreter() {
        const isCustom = interpreterSelectEl.value === 'custom';
        interpreterPathGroupEl.classList.toggle('hidden', !isCustom);
      }

      function toggleOutputFile() {
        outputFileGroupEl.classList.toggle('hidden', !saveOutputToFileEl.checked);
      }

      function addEnvRow(key, value) {
        const row = document.createElement('div');
        row.className = 'env-row';
        row.innerHTML =
          '<input type="text" class="env-key" placeholder="KEY" value="' + escapeHtml(key) + '" />' +
          '<input type="text" class="env-value" placeholder="value" value="' + escapeHtml(value) + '" />' +
          '<button class="remove-btn env-remove">&times;</button>';
        row.querySelector('.env-remove').addEventListener('click', () => {
          row.remove();
        });
        envContainer.appendChild(row);
      }

      function makeId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }

      function renderPreRun() {
        preRunContainer.innerHTML = '';

        if (preRunSteps.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'prerun-empty';
          empty.textContent = 'No before-launch steps. Steps run in order, top to bottom.';
          preRunContainer.appendChild(empty);
          return;
        }

        preRunSteps.forEach((step, index) => {
          preRunContainer.appendChild(buildPreRunRow(step, index));
        });
      }

      function buildPreRunRow(step, index) {
        const row = document.createElement('div');
        row.className = 'prerun-row';

        const head = document.createElement('div');
        head.className = 'prerun-head';

        const enabledEl = document.createElement('input');
        enabledEl.type = 'checkbox';
        enabledEl.checked = step.enabled;
        enabledEl.title = 'Enable this step';
        enabledEl.addEventListener('change', () => {
          step.enabled = enabledEl.checked;
        });

        const typeEl = document.createElement('select');
        [
          ['configuration', 'Run another configuration'],
          ['externalTool', 'Run external tool'],
          ['task', 'Run task'],
        ].forEach(([value, label]) => {
          typeEl.appendChild(makeOption(value, label));
        });
        typeEl.value = step.type;
        typeEl.addEventListener('change', () => {
          step.type = typeEl.value;
          renderPreRun();
        });

        head.appendChild(enabledEl);
        head.appendChild(typeEl);
        head.appendChild(makeIconButton('\u25B2', 'Move up', index === 0, () => movePreRunStep(index, -1)));
        head.appendChild(makeIconButton('\u25BC', 'Move down', index === preRunSteps.length - 1, () => movePreRunStep(index, 1)));
        head.appendChild(makeIconButton('\u00D7', 'Remove step', false, () => {
          preRunSteps.splice(index, 1);
          renderPreRun();
        }));

        const fields = document.createElement('div');
        fields.className = 'prerun-fields';
        buildPreRunFields(step, fields);

        row.appendChild(head);
        row.appendChild(fields);
        return row;
      }

      function buildPreRunFields(step, container) {
        if (step.type === 'configuration') {
          if (availableConfigs.length === 0 && !step.configId) {
            const note = document.createElement('div');
            note.className = 'prerun-empty';
            note.textContent = 'No other configurations in this workspace folder yet.';
            container.appendChild(note);
            return;
          }

          const select = document.createElement('select');
          select.appendChild(makeOption('', 'Select a configuration...'));
          availableConfigs.forEach(item => {
            select.appendChild(makeOption(item.id, item.name));
          });
          if (step.configId && !availableConfigs.some(item => item.id === step.configId)) {
            select.appendChild(makeOption(step.configId, 'Unknown configuration (' + step.configId + ')'));
          }
          select.value = step.configId || '';
          select.addEventListener('change', () => {
            step.configId = select.value;
          });
          container.appendChild(makeLabel('Configuration'));
          container.appendChild(select);
          return;
        }

        if (step.type === 'task') {
          if (availableTasks.length > 0) {
            const select = document.createElement('select');
            select.appendChild(makeOption('', 'Select a task...'));
            availableTasks.forEach(label => select.appendChild(makeOption(label, label)));
            if (step.task && availableTasks.indexOf(step.task) === -1) {
              select.appendChild(makeOption(step.task, step.task));
            }
            select.value = step.task || '';
            select.addEventListener('change', () => {
              step.task = select.value;
            });
            container.appendChild(makeLabel('Task'));
            container.appendChild(select);
            return;
          }

          container.appendChild(makeLabel('Task Label'));
          container.appendChild(makeTextInput(step.task, 'e.g. build', value => {
            step.task = value;
          }));
          return;
        }

        container.appendChild(makeLabel('Command'));
        container.appendChild(makeTextInput(step.command, 'e.g. npm', value => {
          step.command = value;
        }));
        container.appendChild(makeLabel('Arguments'));
        container.appendChild(makeArgsInput(step.argsText, 'e.g. run build', value => {
          step.argsText = value;
        }));
        container.appendChild(makeLabel('Working Directory'));
        container.appendChild(makeTextInput(step.cwd, '\${workspaceFolder}', value => {
          step.cwd = value;
        }));
      }

      function movePreRunStep(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= preRunSteps.length) {
          return;
        }
        const [step] = preRunSteps.splice(index, 1);
        preRunSteps.splice(target, 0, step);
        renderPreRun();
      }

      function makeOption(value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }

      function makeLabel(text) {
        const label = document.createElement('label');
        label.textContent = text;
        return label;
      }

      function makeTextInput(value, placeholder, onChange) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value || '';
        input.placeholder = placeholder;
        input.addEventListener('input', () => onChange(input.value));
        return input;
      }

      function makeArgsInput(value, placeholder, onChange) {
        const row = document.createElement('div');
        row.className = 'args-row';
        const input = makeTextInput(value, placeholder, onChange);
        const button = document.createElement('button');
        button.className = 'expand-btn';
        button.textContent = 'Edit...';
        button.title = 'Open multi-line editor';
        button.addEventListener('click', () => openMultilineEditor(input));
        row.appendChild(input);
        row.appendChild(button);
        return row;
      }

      // Multi-line editor for single-line argument fields (PyCharm-style).
      const multilineOverlay = document.getElementById('multiline-overlay');
      const multilineTextarea = document.getElementById('multiline-textarea');
      let multilineTarget = null;

      function openMultilineEditor(inputEl) {
        multilineTarget = inputEl;
        multilineTextarea.value = expandArgsForEditing(inputEl.value);
        multilineOverlay.classList.remove('hidden');
        multilineTextarea.focus();
        multilineTextarea.setSelectionRange(multilineTextarea.value.length, multilineTextarea.value.length);
      }

      // Inverse of collapseLines: puts each argument on its own line so long
      // argument lists are easier to scan/edit. Spaces inside a quoted
      // argument (e.g. --message "hello world") are kept on one line since
      // parseArgs() treats them as a single argument, not a separator.
      function expandArgsForEditing(text) {
        const lines = [];
        let current = '';
        let inQuote = '';
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (inQuote) {
            current += ch;
            if (ch === inQuote) {
              inQuote = '';
            }
          } else if (ch === '"' || ch === "'") {
            inQuote = ch;
            current += ch;
          } else if (ch === ' ' || ch === '\t') {
            if (current) {
              lines.push(current);
              current = '';
            }
          } else {
            current += ch;
          }
        }
        if (current) lines.push(current);
        return lines.join('\\n');
      }

      function closeMultilineEditor() {
        multilineOverlay.classList.add('hidden');
        const target = multilineTarget;
        multilineTarget = null;
        if (target) {
          target.focus();
        }
      }

      function collapseLines(text) {
        return text
          .split(/\\r?\\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .join(' ');
      }

      function commitMultilineEditor() {
        if (multilineTarget) {
          multilineTarget.value = collapseLines(multilineTextarea.value);
          multilineTarget.dispatchEvent(new Event('input', { bubbles: true }));
        }
        closeMultilineEditor();
      }

      document.getElementById('multiline-ok').addEventListener('click', commitMultilineEditor);
      document.getElementById('multiline-cancel').addEventListener('click', closeMultilineEditor);
      multilineOverlay.addEventListener('mousedown', event => {
        if (event.target === multilineOverlay) {
          closeMultilineEditor();
        }
      });
      multilineTextarea.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMultilineEditor();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commitMultilineEditor();
        }
      });
      document.getElementById('expand-args').addEventListener('click', () => openMultilineEditor(argsEl));

      function makeIconButton(text, title, disabled, onClick) {
        const button = document.createElement('button');
        button.className = 'icon-btn';
        button.textContent = text;
        button.title = title;
        button.disabled = disabled;
        button.addEventListener('click', onClick);
        return button;
      }

      function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function collectFormData() {
        const interpreter = interpreterSelectEl.value === 'custom'
          ? interpreterPathEl.value
          : 'selected';

        const argsStr = argsEl.value.trim();
        const args = argsStr ? parseArgs(argsStr) : [];

        const env = {};
        envContainer.querySelectorAll('.env-row').forEach(row => {
          const key = row.querySelector('.env-key').value.trim();
          const val = row.querySelector('.env-value').value;
          if (key) {
            env[key] = val;
          }
        });

        return {
          id: initialConfig.id,
          name: nameEl.value.trim(),
          runType: runTypeEl.value,
          script: scriptEl.value,
          module: moduleEl.value,
          interpreter: interpreter,
          args: args,
          cwd: cwdEl.value || '\${workspaceFolder}',
          env: env,
          envFile: envFileEl.value.trim(),
          terminal: terminalEl.value,
          runMode: runModeEl.value,
          saveOutputToFile: saveOutputToFileEl.checked,
          outputFile: outputFileEl.value.trim(),
          preRun: preRunSteps.map(step => ({
            id: step.id,
            type: step.type,
            enabled: step.enabled,
            configId: step.configId,
            command: step.command,
            args: step.argsText.trim() ? parseArgs(step.argsText.trim()) : [],
            cwd: step.cwd,
            task: step.task,
          })),
          extra: initialConfig.extra || {},
        };
      }

      // parseArgs / formatArgs: shared with the extension (src/charmrun/webview/argsText.ts).
      ${parseArgs.toString()}
      ${formatArgs.toString()}

      // Event listeners
      runTypeEl.addEventListener('change', toggleRunType);
      interpreterSelectEl.addEventListener('change', toggleInterpreter);
      saveOutputToFileEl.addEventListener('change', toggleOutputFile);
      document.getElementById('add-env').addEventListener('click', () => addEnvRow('', ''));

      document.getElementById('add-prerun').addEventListener('click', () => {
        preRunSteps.push({
          id: makeId(),
          type: preRunTypeEl.value,
          enabled: true,
          configId: '',
          command: '',
          argsText: '',
          cwd: '\${workspaceFolder}',
          task: '',
        });
        renderPreRun();
      });

      const applyStatusEl = document.getElementById('apply-status');
      let applyStatusTimer;

      function showApplyStatus(text) {
        applyStatusEl.textContent = text;
        applyStatusEl.classList.add('visible');
        clearTimeout(applyStatusTimer);
        applyStatusTimer = setTimeout(() => {
          applyStatusEl.classList.remove('visible');
        }, 2000);
      }

      /**
       * Returns the form contents, or null when a required field is missing.
       * Invalid fields are highlighted and focused as a side effect.
       */
      function collectValidatedFormData() {
        const config = collectFormData();
        if (!config.name) {
          nameEl.style.borderColor = 'var(--vscode-inputValidation-errorBorder)';
          nameEl.focus();
          return null;
        }
        return config;
      }

      // Unsaved-change tracking. The extension cannot read the form, so the
      // webview tells it whether the form still matches the last saved state.
      // The extension uses that to confirm before anything discards edits.
      let savedSnapshot = '';
      let reportedDirty = false;

      function isDirty() {
        return JSON.stringify(collectFormData()) !== savedSnapshot;
      }

      /** Treats the current form as the saved state (on load, and after Apply). */
      function markSaved() {
        savedSnapshot = JSON.stringify(collectFormData());
        reportedDirty = false;
        vscode.postMessage({ command: 'dirtyState', dirty: false });
      }

      function updateDirty() {
        const dirty = isDirty();
        if (dirty !== reportedDirty) {
          reportedDirty = dirty;
          vscode.postMessage({ command: 'dirtyState', dirty: dirty });
        }
      }

      // 'input' and 'change' bubble from every field, including rows added
      // after load. Buttons (add/remove/reorder a row or step) mutate state in
      // their own handlers, so re-check once those have run.
      document.addEventListener('input', updateDirty);
      document.addEventListener('change', updateDirty);
      document.addEventListener('click', () => setTimeout(updateDirty, 0));

      document.getElementById('save-btn').addEventListener('click', () => {
        const config = collectValidatedFormData();
        if (config) {
          vscode.postMessage({ command: 'save', config: config });
        }
      });

      document.getElementById('apply-btn').addEventListener('click', () => {
        const config = collectValidatedFormData();
        if (config) {
          vscode.postMessage({ command: 'apply', config: config });
        }
      });

      document.getElementById('run-btn').addEventListener('click', () => {
        const config = collectValidatedFormData();
        if (config) {
          vscode.postMessage({ command: 'run', config: config });
        }
      });

      document.getElementById('debug-btn').addEventListener('click', () => {
        const config = collectValidatedFormData();
        if (config) {
          vscode.postMessage({ command: 'debug', config: config });
        }
      });

      document.getElementById('cancel-btn').addEventListener('click', () => {
        vscode.postMessage({ command: 'cancel', dirty: isDirty() });
      });

      document.getElementById('browse-script').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseScript' });
      });

      document.getElementById('browse-interpreter').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseInterpreter' });
      });

      document.getElementById('browse-cwd').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseCwd' });
      });

      document.getElementById('browse-env-file').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseEnvFile' });
      });

      document.getElementById('browse-output-file').addEventListener('click', () => {
        vscode.postMessage({ command: 'browseOutputFile' });
      });

      // Handle messages from extension
      window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
          case 'setFilePath':
            if (message.field === 'script') scriptEl.value = message.path;
            else if (message.field === 'interpreter') interpreterPathEl.value = message.path;
            else if (message.field === 'cwd') cwdEl.value = message.path;
            else if (message.field === 'envFile') envFileEl.value = message.path;
            else if (message.field === 'outputFile') outputFileEl.value = message.path;
            updateDirty();
            break;
          case 'applied':
            showApplyStatus('Changes applied');
            markSaved();
            break;
        }
      });

      // Clear validation on input
      nameEl.addEventListener('input', () => {
        nameEl.style.borderColor = '';
      });

      // Initialize
      populateForm(initialConfig);
      markSaved();
    })();
  </script>
</body>
</html>`;
}

function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

export function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
