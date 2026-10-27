import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { window, Uri, l10n, type TreeItem } from 'vscode';
import { CompareFoldersProvider } from '../../providers/foldersCompareProvider';
import { ViewOnlyProvider } from '../../providers/viewOnlyProvider';
import { warnBefore } from '../../utils/ui';
import { mockConfiguration } from './mocks/configuration';

// Replaces the modal confirmation with a scripted answer and records each prompt.
function stubConfirm(answer: 'yes' | 'cancel') {
  const original = window.showInformationMessage;
  const prompts: unknown[] = [];
  Object.assign(window, {
    showInformationMessage: async (message: unknown) => {
      prompts.push(message);
      return answer === 'yes' ? l10n.t('Yes, go for it') : undefined;
    },
  });
  return { prompts, restore: () => Object.assign(window, { showInformationMessage: original }) };
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-test-'));
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  return file;
}

function newProvider() {
  return new CompareFoldersProvider(new ViewOnlyProvider(), new ViewOnlyProvider(), new ViewOnlyProvider(false));
}

async function deleteWith(config: Record<string, unknown>, answer: 'yes' | 'cancel') {
  const file = tempFile();
  const restoreConfig = mockConfiguration(config);
  const confirm = stubConfirm(answer);
  try {
    await newProvider().deleteFile({ resourceUri: Uri.file(file) } as TreeItem);
  } finally {
    confirm.restore();
    restoreConfig();
  }
  return { exists: fs.existsSync(file), prompts: confirm.prompts.length };
}

suite('delete / take confirmations (warnBeforeDelete bug)', () => {
  test('delete asks when warnBeforeDelete is on, even with warnBeforeTake off; cancel keeps the file', async () => {
    const r = await deleteWith({ warnBeforeDelete: true, warnBeforeTake: false }, 'cancel');
    assert.strictEqual(r.prompts, 1);
    assert.strictEqual(r.exists, true);
  });

  test('delete does not ask when warnBeforeDelete is off, even with warnBeforeTake on', async () => {
    const r = await deleteWith({ warnBeforeDelete: false, warnBeforeTake: true }, 'cancel');
    assert.strictEqual(r.prompts, 0);
    assert.strictEqual(r.exists, false);
  });

  test('delete removes the file when the user confirms', async () => {
    const r = await deleteWith({ warnBeforeDelete: true, warnBeforeTake: true }, 'yes');
    assert.strictEqual(r.prompts, 1);
    assert.strictEqual(r.exists, false);
  });

  test('take follows warnBeforeTake, not warnBeforeDelete', async () => {
    const restoreConfig = mockConfiguration({ warnBeforeDelete: true, warnBeforeTake: false });
    const confirm = stubConfirm('cancel');
    try {
      assert.strictEqual(await warnBefore('take?', 'warnBeforeTake'), true);
      assert.strictEqual(confirm.prompts.length, 0);
    } finally {
      confirm.restore();
      restoreConfig();
    }
  });
});
