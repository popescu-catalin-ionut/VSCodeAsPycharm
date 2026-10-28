import * as assert from 'assert';
import { env, l10n, window, type Uri } from 'vscode';
import { buildIssueUri, showErrorMessage } from '../../utils/ui';

// What VS Code's opener does with an external Uri before handing it to the browser.
const hrefOf = (uri: Uri) => new URL(encodeURI(uri.toString(true)));

suite('Error "Report" button', () => {
  test('opens a new issue on our Forgejo, not on upstream GitHub (bug: went to moshfeu/vscode-compare-folders)', async () => {
    const opened: Uri[] = [];
    const originalOpen = env.openExternal;
    const originalError = window.showErrorMessage;
    Object.assign(env, { openExternal: async (uri: Uri) => { opened.push(uri); return true; } });
    Object.assign(window, { showErrorMessage: async () => l10n.t('Report') });
    try {
      await showErrorMessage('Copy failed', new Error('EPERM: operation not permitted'));
    } finally {
      Object.assign(env, { openExternal: originalOpen });
      Object.assign(window, { showErrorMessage: originalError });
    }
    assert.strictEqual(opened.length, 1);
    const href = hrefOf(opened[0]);
    assert.strictEqual(href.origin, 'http://192.168.3.241:3000');
    assert.strictEqual(href.pathname, '/catalinpop/VSCodeAsPycharm/issues/new');
  });

  test('title and body arrive whole, even with &, # and + in the error', () => {
    const error = new Error('a & b #1 + c');
    error.stack = 'Error: a & b #1 + c\n    at x (file.ts:1:2)';
    const href = hrefOf(buildIssueUri('Copy & paste failed', error));
    assert.strictEqual(href.searchParams.get('title'), '[error] a ＆ b ＃1 ＋ c');
    const body = href.searchParams.get('body')!;
    assert.ok(body.includes('**Original message**: Copy ＆ paste failed'), body);
    assert.ok(body.includes('at x (file.ts:1:2)'), body);
    assert.ok(body.includes('Editor version:'), body);
  });
});
