// Git Blame Annotations: "Annotate with Git Blame" in the editor gutter, as in JetBrains IDEs.
// Port of lkqm/vscode-gitblame-annotations 0.5.3 (MIT, licence in resources/gitBlame/), src/extension.ts.
// Changes: IDs under aspycharm.gitBlame; the hover escapes commit messages, author names and links and may run only
// this feature's commands (upstream trusted every command link, so a commit message could carry a command: link);
// unsaved edits are blamed as "not committed"; one hover provider for all files (upstream registered one per file,
// with the file path as a glob); the development-only window reload is gone.
import * as path from 'path';
import * as vscode from 'vscode';
import { Uri } from 'vscode';
import {
  Blame, buildCommitUrl, getBlames, getChanges, getEmptyTree, getFileRevisionNumbers, getFileStatus, getGitRepository,
  getParentCommitId, getRepoWebBase, UNCOMMITTED,
} from './git';
import { registerLineHistoryProviders, showLineHistory } from './lineHistory';
import type { AbsoluteDateFormatStyle, AuthorNameStyle, GitBlameConfig } from './format';
import {
  buildUncommitBlame, CONFIG_SECTION, defaultDateFormatStyle, escapeMarkdown, formatAuthor, formatDate,
  formatDateTime, getCommitColor, getGitBlameConfig, getRepositoryRelativePath, getTextWidth, resolveChange,
  safeLinkTarget, toMultiFileDiffEditorUris, toNamedGitUri, truncateText,
} from './format';

export const GIT_BLAME_COMMANDS = {
  toggle: 'aspycharm.gitBlame.toggle',
  show: 'aspycharm.gitBlame.show',
  hide: 'aspycharm.gitBlame.hide',
  viewLineHistory: 'aspycharm.gitBlame.viewLineHistory',
  viewCommit: 'aspycharm.gitBlame.viewCommit',
  copyHash: 'aspycharm.gitBlame.copyHash',
  annotatePreviousRevision: 'aspycharm.gitBlame.annotatePreviousRevision',
};
/** The only commands a blame hover may run. */
export const HOVER_COMMANDS = [
  GIT_BLAME_COMMANDS.viewCommit, GIT_BLAME_COMMANDS.copyHash, GIT_BLAME_COMMANDS.annotatePreviousRevision,
  GIT_BLAME_COMMANDS.viewLineHistory,
];
const CAN_SHOW = 'aspycharm.gitBlame.canShow';
const CAN_HIDE = 'aspycharm.gitBlame.canHide';

interface BlameContext {
  fileName: string;
  ref?: string;
  repositoryRoot: string;
}

interface FileDecorations {
  decorationTypes: vscode.TextEditorDecorationType[] | undefined;
  decorationOptions: vscode.DecorationOptions[][] | undefined;
  blames: Blame[] | undefined;
  context: BlameContext | undefined;
  repoWebBase: string;
  highlightDecorationType: vscode.TextEditorDecorationType | undefined;
  /** Counts blame runs, so a run that a newer one or a hide overtook while git was running does nothing. */
  run: number;
}

const fileBlameStates = new Map<string, boolean>();
const fileDecorations = new Map<string, FileDecorations>();

const MaxAuthorWidth = 14;

/** Whether annotations are on for the document (for tests and other features). */
export function isBlameShown(documentUri: Uri): boolean {
  return fileBlameStates.get(documentUri.toString()) === true;
}

/** The gutter text per line while annotations are shown (for tests). */
export function blameTitles(documentUri: Uri): string[] | undefined {
  return fileDecorations.get(documentUri.toString())?.blames?.map((b) => b.title);
}

export function registerGitBlame(context: vscode.ExtensionContext): void {
  registerCommands(context);
  registerListeners(context);
  registerLineHistoryProviders(context);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider([{ scheme: 'file' }, { scheme: 'git' }], { provideHover }),
    { dispose: disposeAll },
  );
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    void updateMenuContext(editor.document);
  }
}

function disposeAll() {
  for (const decorations of fileDecorations.values()) {
    disposeDecorations(decorations);
  }
  fileDecorations.clear();
  fileBlameStates.clear();
}

function disposeDecorations(decorations: FileDecorations) {
  decorations.decorationTypes?.forEach((type) => type.dispose());
  decorations.highlightDecorationType?.dispose();
}

function editorsOf(documentUri: string): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter((e) => e.document.uri.toString() === documentUri);
}

function registerCommands(context: vscode.ExtensionContext) {
  const toggle = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.toggle, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const document = editor.document;
    const documentUri = document.uri.toString();
    if (!fileBlameStates.get(documentUri)) {
      if (await showDecorations(editorsOf(documentUri), false, true)) {
        void updateMenuContext(document, true);
      }
    } else if (await hideDecorations(document)) {
      void updateMenuContext(document, false);
    }
  });

  // From the line-number context menu VS Code passes { uri, lineNumber }.
  const show = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.show, async (event?: { uri?: Uri }) => {
    const documentUri = (event?.uri ?? vscode.window.activeTextEditor?.document.uri)?.toString() ?? '';
    const editors = documentUri ? editorsOf(documentUri) : [];
    if (editors.length > 0 && await showDecorations(editors, false, true)) {
      void updateMenuContext(editors[0].document, true);
    }
  });

  const hide = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.hide, async (event?: { uri?: Uri }) => {
    const document = event?.uri
      ? vscode.workspace.textDocuments.find((d) => d.uri.toString() === event.uri!.toString())
      : vscode.window.activeTextEditor?.document;
    if (document && await hideDecorations(document)) {
      void updateMenuContext(document, false);
    }
  });

  const viewCommit = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.viewCommit,
    async (commitId: string, summary = '', fileName = '', repositoryRoot = '') => {
      if (!fileName || !commitId) {
        return;
      }
      try {
        repositoryRoot = repositoryRoot || await getGitRepository(fileName);
        if (!repositoryRoot) {
          return;
        }
        const title = `${commitId.substring(0, 7)} ${summary ? `- ${summary.substring(0, 20)}` : ''}`;
        const parentCommitId = await getParentCommitId(repositoryRoot, commitId) || await getEmptyTree(repositoryRoot);
        const multiDiffSourceUri = Uri.from({ scheme: 'scm-history-item', path: `${repositoryRoot}/${parentCommitId}..${commitId}` });
        const changes = await getChanges(repositoryRoot, parentCommitId, commitId);
        const resources = changes.map((c) => toMultiFileDiffEditorUris(c, parentCommitId, commitId));
        await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', { multiDiffSourceUri, title, resources });
      } catch (error) {
        void vscode.window.showErrorMessage(`${(error as Error).message}`);
      }
    });

  const copyHash = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.copyHash, async (hash: string) => {
    if (hash) {
      await vscode.env.clipboard.writeText(hash);
    }
  });

  const annotatePreviousRevision = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.annotatePreviousRevision,
    async (previousCommit: string, previousFile = '', fileName = '', repositoryRoot = '', languageId = '') => {
      if (!previousCommit || !fileName) {
        return;
      }
      try {
        const repoRoot = repositoryRoot || await getGitRepository(fileName);
        if (!repoRoot) {
          return;
        }
        const previousFileName = previousFile
          ? (path.isAbsolute(previousFile) ? previousFile : path.join(repoRoot, previousFile))
          : fileName;
        const uri = toNamedGitUri(previousFileName, previousCommit, repoRoot);
        let editor = await vscode.window.showTextDocument(uri, { preview: false });
        if (languageId && editor.document.languageId !== languageId) {
          const document = await vscode.languages.setTextDocumentLanguage(editor.document, languageId);
          editor = await vscode.window.showTextDocument(document, { preview: false });
        }
        if (await showDecorations([editor], true)) {
          void updateMenuContext(editor.document, true);
        }
      } catch (error) {
        void vscode.window.showErrorMessage(`${(error as Error).message}`);
      }
    });

  const viewLineHistory = vscode.commands.registerCommand(GIT_BLAME_COMMANDS.viewLineHistory,
    async (fileName = '', lineNumber?: number, ref?: string, repositoryRoot = '') => {
      const activeEditor = vscode.window.activeTextEditor;
      let targetLine = lineNumber;
      let activeDocument: vscode.TextDocument | undefined;

      if (!fileName && activeEditor) {
        const blameContext = await getBlameDocumentContext(activeEditor.document);
        fileName = blameContext?.fileName ?? '';
        ref = blameContext?.ref;
        repositoryRoot = blameContext?.repositoryRoot ?? '';
        targetLine = activeEditor.selection.active.line + 1;
        activeDocument = activeEditor.document;
      } else if (activeEditor && activeEditor.document.fileName === fileName) {
        activeDocument = activeEditor.document;
      }

      await showLineHistory({ fileName, lineNumber: targetLine, ref, repositoryRoot, activeDocument });
    });

  context.subscriptions.push(toggle, show, hide, viewCommit, copyHash, annotatePreviousRevision, viewLineHistory);
}

function registerListeners(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        void updateMenuContext(editor.document);
      }
    }),

    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) {
        if (fileBlameStates.get(editor.document.uri.toString())) {
          void showDecorations([editor]);
        }
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => {
      const documentUri = document.uri.toString();
      fileBlameStates.delete(documentUri);
      blameable.delete(documentUri);
      const decorations = fileDecorations.get(documentUri);
      if (decorations) {
        fileDecorations.delete(documentUri);
        disposeDecorations(decorations);
      }
    }),

    vscode.workspace.onDidSaveTextDocument(async (document) => {
      const documentUri = document.uri.toString();
      blameable.delete(documentUri); // a new file saved, or one just added to git, may be blameable now
      if (fileBlameStates.get(documentUri)) {
        const editors = editorsOf(documentUri);
        if (editors.length > 0) {
          await showDecorations(editors, true);
        }
      }
    }),

    vscode.workspace.onDidChangeTextDocument(async (event) => {
      const documentUri = event.document.uri.toString();
      if (event.contentChanges.length > 0 && fileBlameStates.get(documentUri)) {
        const editors = editorsOf(documentUri);
        if (editors.length === 0) {
          return;
        }
        if (!event.document.isDirty) {
          // Back to the saved text (Undo, Revert) or reloaded from disk (git checkout, pull): blame it again.
          await showDecorations(editors, true);
        } else {
          updateDecorationsOnChange(editors, event);
        }
      }
    }),

    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      const config = getGitBlameConfig();
      const shouldRefreshAnnotations = ['mergeCommitLines', 'showCommitNumber', 'dateFormatStyle', 'authorNameStyle']
        .some((key) => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`));
      const shouldUpdateHighlight = event.affectsConfiguration(`${CONFIG_SECTION}.highlightChangedLines`);
      const blamedDocumentUris = [...fileBlameStates.entries()].filter(([, enabled]) => enabled).map(([uri]) => uri);
      for (const documentUri of blamedDocumentUris) {
        const editors = editorsOf(documentUri);
        if (shouldUpdateHighlight) {
          editors.forEach((editor) => updateCommitHighlight(editor, config.highlightChangedLines));
        }
        if (shouldRefreshAnnotations) {
          if (editors.length > 0) {
            await showDecorations(editors, true);
            continue;
          }
          const decorations = fileDecorations.get(documentUri);
          if (decorations) {
            decorations.decorationOptions = undefined;
          }
        }
      }
    }),

    // Highlight all lines of the commit under the cursor.
    // Runs on every cursor move: nothing to do (not even reading settings) unless this file is annotated.
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (fileBlameStates.get(event.textEditor.document.uri.toString()) && getGitBlameConfig().highlightChangedLines) {
        updateCommitHighlight(event.textEditor, true);
      }
    }),
  );
}

function applyDecorations(editors: vscode.TextEditor[], decorations: FileDecorations) {
  const options = decorations.decorationOptions ?? [];
  decorations.decorationTypes = decorations.decorationTypes ?? [];
  for (let i = decorations.decorationTypes.length; i < options.length; i++) {
    decorations.decorationTypes.push(vscode.window.createTextEditorDecorationType({}));
  }
  for (const editor of editors) {
    decorations.decorationTypes.forEach((type, i) => editor.setDecorations(type, options[i] ?? []));
  }
}

/**
 * Blames the document and shows the annotations in its editors.
 * @param explicit the user asked for it (a command), so say why when it cannot be done
 */
async function showDecorations(editors: vscode.TextEditor[], reload = false, explicit = false): Promise<boolean> {
  const document = editors[0].document;
  const documentUri = document.uri.toString();
  if (document.uri.scheme !== 'file' && document.uri.scheme !== 'git') {
    if (explicit) {
      void vscode.window.showInformationMessage('Annotate with Git Blame works on files saved in a Git repository.');
    }
    return false;
  }
  let decorations = fileDecorations.get(documentUri);

  // Use cache
  if (!reload && decorations?.decorationTypes && decorations.decorationOptions) {
    applyDecorations(editors, decorations);
    fileBlameStates.set(documentUri, true);
    return true;
  }

  const created = !decorations;
  if (!decorations) {
    decorations = {
      decorationTypes: undefined, decorationOptions: undefined, blames: undefined, context: undefined,
      repoWebBase: '', highlightDecorationType: undefined, run: 0,
    };
    fileDecorations.set(documentUri, decorations);
  }
  const run = ++decorations.run;
  // Hidden, closed or blamed again while git was running: this run's result is out of date.
  const overtaken = () => fileDecorations.get(documentUri) !== decorations || decorations!.run !== run;
  const forget = () => {
    if (created && !overtaken() && !decorations!.decorationTypes) {
      fileDecorations.delete(documentUri);
    }
  };

  try {
    const blameContext = await getBlameDocumentContext(document);
    if (!blameContext) {
      forget();
      if (explicit) {
        void vscode.window.showInformationMessage(
          `Annotate with Git Blame: ${path.basename(document.fileName)} is not in a Git repository, or git was not found on PATH.`);
      }
      return false;
    }

    const config = getGitBlameConfig();
    const blameFile = getRepositoryRelativePath(blameContext.repositoryRoot, blameContext.fileName);
    // Unsaved edits: blame the editor's text, so edited lines show as not committed and the rest stay in place.
    const contents = !blameContext.ref && document.isDirty ? document.getText() : undefined;
    const blames = await getBlames(blameContext.repositoryRoot, blameFile, blameContext.ref, contents);
    if (config.showCommitNumber) {
      const commitNumbers = await getFileRevisionNumbers(blameContext.repositoryRoot, blameFile, blameContext.ref);
      blames.forEach((blame) => {
        blame.commitNumber = commitNumbers.get(blame.commit);
      });
    }
    for (let i = 0; i < document.lineCount; i++) {
      blames[i] = blames[i] ?? buildUncommitBlame(i + 1);
    }

    const repoWebBase = await getRepoWebBase(blameContext.repositoryRoot);
    if (overtaken()) {
      return false;
    }
    decorations.repoWebBase = repoWebBase;
    decorations.context = blameContext;
    decorations.decorationOptions = buildDecorationOptions(blames, config);
    decorations.blames = blames;
    applyDecorations(editors, decorations);
    fileBlameStates.set(documentUri, true);
    return true;
  } catch (error) {
    forget();
    const message = (error as Error).message ?? `${error}`;
    // Code 128 is git's "fatal" (for example a file that was never committed); say so only when asked.
    if (explicit || document.uri.scheme === 'git' || !message.includes('code 128')) {
      void vscode.window.showErrorMessage(message);
    }
    return false;
  }
}

function provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
  if (position.character > 0) {
    return undefined;
  }
  const decorations = fileDecorations.get(document.uri.toString());
  const blame = decorations?.blames?.[position.line];
  if (!decorations?.context || !blame || !fileBlameStates.get(document.uri.toString())) {
    return undefined;
  }
  const { fileName, repositoryRoot, ref } = decorations.context;
  // The line as it is now: edits since the blame move lines, and blame.line stays the old number.
  const lineNow = { ...blame, line: position.line + 1 };
  const content = buildHoverMessage(lineNow, fileName, decorations.repoWebBase, repositoryRoot, document.languageId, ref);
  return content && new vscode.Hover(content, new vscode.Range(position.line, 0, position.line, 0));
}

async function getBlameDocumentContext(document: vscode.TextDocument): Promise<BlameContext | undefined> {
  if (document.uri.scheme === 'file') {
    const repositoryRoot = await getGitRepository(document.fileName);
    return repositoryRoot ? { fileName: document.fileName, repositoryRoot } : undefined;
  }

  if (document.uri.scheme === 'git') {
    try {
      const params = JSON.parse(document.uri.query) as { path?: string; ref?: string; repositoryRoot?: string };
      if (!params.path || !params.ref) {
        return undefined;
      }
      const repositoryRoot = params.repositoryRoot
        || findWorkspaceRootForPath(params.path)
        || await getGitRepository(params.path);
      return repositoryRoot ? { fileName: params.path, ref: params.ref, repositoryRoot } : undefined;
    } catch (_) {
      return undefined;
    }
  }

  return undefined;
}

function findWorkspaceRootForPath(fileName: string): string | undefined {
  return (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath)
    .filter((root) => {
      const relativePath = path.relative(root, fileName);
      return relativePath === '' || (!!relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    })
    .sort((a, b) => b.length - a.length)[0];
}

async function hideDecorations(document: vscode.TextDocument): Promise<boolean> {
  const documentUri = document.uri.toString();
  fileBlameStates.set(documentUri, false);
  const decorations = fileDecorations.get(documentUri);
  if (decorations) {
    fileDecorations.delete(documentUri);
    disposeDecorations(decorations);
    return true;
  }
  return false;
}

/** Keeps the annotations on their lines while the document is edited (the next save blames it again). */
function updateDecorationsOnChange(editors: vscode.TextEditor[], event: vscode.TextDocumentChangeEvent) {
  const decorations = fileDecorations.get(editors[0].document.uri.toString());
  const blames = decorations?.blames;
  if (!decorations?.decorationTypes || !blames) {
    return;
  }

  let shouldUpdate = false;
  for (const change of event.contentChanges) {
    const { addedLines, deletedLines, modifiedLines } = resolveChange(change);
    for (const line of modifiedLines) {
      if (blames[line]?.commited) {
        blames[line] = { ...blames[line], commit: UNCOMMITTED, commited: false };
        shouldUpdate = true;
      }
    }
    if (deletedLines.length > 0) {
      shouldUpdate = true;
      for (let i = deletedLines.length - 1; i >= 0; i--) {
        blames.splice(deletedLines[i], 1);
      }
    }
    if (addedLines.length > 0) {
      shouldUpdate = true;
      for (const line of addedLines) {
        blames.splice(line, 0, buildUncommitBlame(line + 1));
      }
    }
  }
  if (!shouldUpdate) {
    return;
  }

  decorations.decorationOptions = buildDecorationOptions(blames);
  decorations.blames = blames;
  applyDecorations(editors, decorations);
}

/** Whether a document can be blamed (a file git tracks), asked once per document and again after a save. */
const blameable = new Map<string, Promise<boolean>>();
/** Counts menu updates, so a slow answer for an editor that is no longer active is dropped. */
let menuRun = 0;

function canBlame(document: vscode.TextDocument): Promise<boolean> {
  const key = document.uri.toString();
  let known = blameable.get(key);
  if (!known) {
    known = askCanBlame(document);
    blameable.set(key, known);
  }
  return known;
}

async function askCanBlame(document: vscode.TextDocument): Promise<boolean> {
  if (document.uri.scheme === 'git') {
    try {
      const params = JSON.parse(document.uri.query) as { path?: string; ref?: string };
      return !!params.path && !!params.ref;
    } catch (_) {
      return false;
    }
  }
  if (document.uri.scheme === 'file') {
    try {
      const fileStatus = await getFileStatus(path.dirname(document.fileName), document.fileName);
      return fileStatus !== 'untracked' && fileStatus !== 'index_add';
    } catch (_) {
      return false;
    }
  }
  return false;
}

/** Sets which of Annotate / Close Annotations the line-number menu offers for the active editor. */
async function updateMenuContext(document: vscode.TextDocument, currentState?: boolean) {
  const run = ++menuRun;
  if (currentState !== undefined) {
    void vscode.commands.executeCommand('setContext', CAN_SHOW, !currentState);
    void vscode.commands.executeCommand('setContext', CAN_HIDE, currentState);
    return;
  }

  const supportsBlameMenu = await canBlame(document);
  if (run !== menuRun) {
    return;
  }
  const fileBlameState = fileBlameStates.get(document.uri.toString()) || false;
  void vscode.commands.executeCommand('setContext', CAN_SHOW, supportsBlameMenu && !fileBlameState);
  void vscode.commands.executeCommand('setContext', CAN_HIDE, supportsBlameMenu && fileBlameState);
}

function updateCommitHighlight(editor: vscode.TextEditor, enabled: boolean) {
  const uri = editor.document.uri.toString();
  const state = fileDecorations.get(uri);
  if (!fileBlameStates.get(uri) || !state || (!enabled && !state.highlightDecorationType)) {
    return;
  }
  if (!state.highlightDecorationType) {
    state.highlightDecorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(0, 188, 242, 0.2)',
    });
  }
  const blame = state.blames?.[editor.selection.active.line];
  if (!enabled || !blame?.commited) {
    editor.setDecorations(state.highlightDecorationType, []);
    return;
  }
  const ranges = (state.blames ?? [])
    .map((b, i) => (b.commit === blame.commit ? new vscode.Range(i, 0, i, 0) : undefined))
    .filter((r): r is vscode.Range => r !== undefined);
  editor.setDecorations(state.highlightDecorationType, ranges);
}

function buildDecorationOptions(blames: Blame[], config: GitBlameConfig = getGitBlameConfig()): vscode.DecorationOptions[][] {
  const maxWidth = fillTitles(blames, config);
  if (maxWidth <= 0) {
    return [[], []];
  }

  const singleCommit = new Set(blames.filter((b) => b.commited).map((b) => b.commit)).size === 1;
  const decorationOptions: vscode.DecorationOptions[] = [];
  const decorationOptionsHeatmap: vscode.DecorationOptions[] = [];
  const colorsMap = new Map<string, { lightColor: string; darkColor: string }>();
  blames.forEach((blame, index) => {
    let color = colorsMap.get(blame.commit);
    if (!color) {
      color = getCommitColor(blame.commit, blame.timestamp);
      colorsMap.set(blame.commit, color);
    }
    const range = new vscode.Range(index, 0, index, 0);
    decorationOptions.push({
      range,
      renderOptions: {
        before: {
          contentText: ` ${blame.title} `,
          color: new vscode.ThemeColor('list.deemphasizedForeground'),
          width: `${maxWidth + 2}ch`,
          fontWeight: 'normal',
          fontStyle: 'normal',
        },
      },
    });
    const plain = singleCommit || !blame.commited;
    decorationOptionsHeatmap.push({
      range,
      renderOptions: {
        before: { contentText: ' ', width: '2px', margin: '0 25px 0 0' },
        light: { before: { backgroundColor: plain ? 'transparent' : color.lightColor } },
        dark: { before: { backgroundColor: plain ? 'transparent' : color.darkColor } },
      },
    });
  });

  return [decorationOptions, decorationOptionsHeatmap];
}

/** A command: link's argument list, encoded so no character of it can end the Markdown link. */
function commandArgs(args: unknown[]): string {
  return encodeURIComponent(JSON.stringify(args))
    .replace(/[()'!*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildHoverMessage(
  blame: Blame, fileName: string, repoWebBase: string, repositoryRoot: string, languageId: string, ref?: string,
): vscode.MarkdownString | undefined {
  if (!blame.commited) {
    return undefined;
  }

  const activeStyle = getGitBlameConfig().dateFormatStyle;
  const relativeDate = formatDate(blame.timestamp, 'relative');
  const hoverStyle: AbsoluteDateFormatStyle = activeStyle === 'relative' ? defaultDateFormatStyle : activeStyle;
  const dateText = formatDateTime(blame.timestamp, hoverStyle);

  const content = new vscode.MarkdownString();
  const author = escapeMarkdown(blame.author);
  const mail = blame.mail.replace(/^<|>$/g, '');
  const mailLink = /^[^\s<>()[\]\\"'`]+@[^\s<>()[\]\\"'`]+$/.test(mail) ? `mailto:${mail}` : '';
  content.appendMarkdown(mailLink ? `**[${author}](${mailLink})**  \n` : `**${author}**  \n`);
  content.appendMarkdown(`_${escapeMarkdown(relativeDate)}_ (${escapeMarkdown(dateText)})  \n`);

  if (blame.summary) {
    content.appendMarkdown(`\n\n${escapeMarkdown(blame.summary)}`);
  }

  let viewExternal = '';
  const [commitUrl, gitPlatform] = buildCommitUrl(repoWebBase, blame.commit);
  const link = safeLinkTarget(commitUrl);
  if (link) {
    viewExternal = ` | [${gitPlatform ? `Open on ${gitPlatform}` : 'Open in Browser'}](${link})`;
  }

  const commitLink = `[${escapeMarkdown(blame.commit.slice(0, 8))}](command:${GIT_BLAME_COMMANDS.viewCommit}?${commandArgs([blame.commit, blame.summary, fileName, repositoryRoot])})`;
  const copyIcon = `[$(copy)](command:${GIT_BLAME_COMMANDS.copyHash}?${commandArgs([blame.commit])})`;
  let annotatePreviousRevision = '';
  if (blame.previousCommit) {
    annotatePreviousRevision = ` | [Previous Revision](command:${GIT_BLAME_COMMANDS.annotatePreviousRevision}?${commandArgs([blame.previousCommit, blame.previousFile ?? '', fileName, repositoryRoot, languageId])})`;
  }
  const lineHistory = `[Line History](command:${GIT_BLAME_COMMANDS.viewLineHistory}?${commandArgs([fileName, blame.line, ref, repositoryRoot])})`;

  content.appendMarkdown('\n\n---\n\n');
  content.appendMarkdown(`$(git-commit) ${commitLink} ${copyIcon}${viewExternal}${annotatePreviousRevision} | ${lineHistory}  \n`);

  // Only this feature's commands (VS Code 1.77+; @types/vscode 1.73 types isTrusted as a boolean).
  (content as { isTrusted: unknown }).isTrusted = { enabledCommands: HOVER_COMMANDS };
  content.supportThemeIcons = true;
  return content;
}

function fillTitles(blames: Blame[], config: GitBlameConfig): number {
  let maxWidth = 0;

  const lineTimestampText = new Map<number, string>();
  const maxTimestampWidth = blames.reduce((maxW, line) => {
    if (!line.commited) {
      return maxW;
    }
    const text = formatDate(line.timestamp, config.dateFormatStyle);
    lineTimestampText.set(line.line, text);
    return Math.max(maxW, text.length);
  }, 8);
  const maxCommitNumberWidth = config.showCommitNumber
    ? blames.reduce((maxW, line) => (!line.commited || !line.commitNumber ? maxW : Math.max(maxW, `${line.commitNumber}`.length)), 0)
    : 0;
  const lineAuthorDisplay = new Map<number, { text: string; width: number; widths: number[] }>();
  const maxAuthorWidth = getMaxAuthorWidth(blames, config.authorNameStyle, lineAuthorDisplay);
  blames.forEach((line) => {
    if (line.commited) {
      const tsText = (lineTimestampText.get(line.line) ?? '').padEnd(maxTimestampWidth, ' ');
      const authorText = buildAuthorBlock(lineAuthorDisplay.get(line.line)!, maxAuthorWidth);
      const commitNumberText = config.showCommitNumber && line.commitNumber
        ? ` ${`${line.commitNumber}`.padStart(maxCommitNumberWidth, ' ')}`
        : '';
      line.title = `${tsText} ${authorText}${commitNumberText}`;
    } else {
      line.title = '';
    }
    maxWidth = Math.max(maxWidth, getTextWidth(line.title).width);
  });

  // Blank the non-first lines of each run of lines from the same commit.
  if (config.mergeCommitLines) {
    for (let i = blames.length - 1; i >= 1; i--) {
      if (blames[i].commited && blames[i].commit === blames[i - 1].commit) {
        blames[i].title = '';
      }
    }
  }

  return maxWidth;
}

function getMaxAuthorWidth(
  blames: Blame[], authorNameStyle: AuthorNameStyle, lineAuthorDisplay: Map<number, { text: string; width: number; widths: number[] }>,
): number {
  const maxWidth = blames.reduce((maxW, line) => {
    if (!line.commited) {
      return maxW;
    }
    const text = formatAuthor(line.author, authorNameStyle);
    const { width, widths } = getTextWidth(text);
    lineAuthorDisplay.set(line.line, { text, width, widths });
    return Math.max(maxW, width);
  }, 0);
  return Math.min(maxWidth, MaxAuthorWidth);
}

function buildAuthorBlock(author: { text: string; width: number; widths: number[] }, maxAuthorWidth: number): string {
  if (author.width <= maxAuthorWidth) {
    return author.text.padEnd(author.text.length + maxAuthorWidth - author.width, ' ');
  }
  return truncateText(author.text, maxAuthorWidth - 1, author.widths) + '…';
}
