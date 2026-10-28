import { window, ProgressLocation, env, Uri, version, l10n } from 'vscode';
import os from 'os';
import * as logger from '../services/logger';
import { globalState } from '../services/globalState';
import { getConfiguration } from '../services/configuration';
import { ISSUES_AUTHORITY, ISSUES_NEW_PATH } from './consts';

export function showInfoMessageWithTimeout(message: string, timeout: number = 3000) {
  const upTo = timeout / 10;
  window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: message,
      cancellable: true,
    },
    async (progress) => {
      let counter = 0;
      return new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          progress.report({ increment: counter / upTo });
          if (++counter === upTo) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });
    }
  );
}

export async function showDoneableInfo(title: string, callback: () => Promise<void>) {
  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title,
    },
    async () => callback()
  );
}

export async function showErrorMessage(message: string, error: any) {
  const report = l10n.t('Report');
  if ((await window.showErrorMessage(message, report)) === report) {
    try {
      env.openExternal(buildIssueUri(message, error));
    } catch (error) {
      logger.log(error);
    }
  }
}

// A "new issue" link on our Forgejo, with the error as title and body.
// VS Code opens external links as encodeURI(uri.toString(true)): the query is decoded and then only lightly
// re-encoded, so "&", "#" and "+" in the text would cut or garble it. They are swapped for look-alikes.
export function buildIssueUri(message: string, error: any): Uri {
  const safe = (text: string) => text.replace(/&/g, '＆').replace(/#/g, '＃').replace(/\+/g, '＋');
  const body = `**Original message**: ${message}

**System Info**
Editor version: ${version}
Extension version: ${globalState.extensionVersion}
OS: ${os.platform()} ${os.release()}

**Stack**
${error?.stack || error?.message || error}
`;
  return Uri.from({
    scheme: 'http',
    authority: ISSUES_AUTHORITY,
    path: ISSUES_NEW_PATH,
    query: `title=${safe(`[error] ${error?.message || error}`)}&body=${safe(body)}`,
  });
}

export async function showErrorMessageWithMoreInfo(message: string, link: string) {
  const moreInfo = l10n.t('More Info');
  const result = await window.showErrorMessage(message, moreInfo);
  if (result === moreInfo) {
    env.openExternal(Uri.parse(link));
  }
}

// Asks for confirmation when `setting` is on; returns whether to go ahead.
export const warnBefore = async (message: string, setting: 'warnBeforeDelete' | 'warnBeforeTake') => {
  if (getConfiguration(setting)) {
    const yesMessage = l10n.t('Yes, go for it');
    return yesMessage ===
      (await window.showInformationMessage(
        message,
        {
          modal: true,
        },
        yesMessage
      ));
  }

  return true;
}