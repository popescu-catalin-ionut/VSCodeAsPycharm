import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { commands, extensions, Hover, MarkdownString, Position, Uri, window, workspace } from 'vscode';
import {
  blameTitles, buildHoverMessage, GIT_BLAME_COMMANDS, HOVER_COMMANDS, isBlameShown,
} from '../../gitBlame/annotations';
import {
  Blame, buildCommitUrl, checkRef, exec, getFileRevisionNumbers, isCommitted, parseBlames, readAll, toWebBaseUrl,
} from '../../gitBlame/git';
import { isSamePath } from '../../gitBlame/lineHistory';
import { escapeMarkdown, formatRelative, getTextWidth, safeLinkTarget, truncateText } from '../../gitBlame/format';

const COMMIT = '1234567890abcdef1234567890abcdef12345678';

function blame(overrides: Partial<Blame> = {}): Blame {
  return {
    line: 3, sourceLine: 3, author: 'Ana Pop', mail: '<ana@example.com>', commit: COMMIT, summary: 'Fix the parser',
    timestamp: 1_700_000_000, commited: true, title: '', ...overrides,
  };
}

const hoverText = (b: Blame, webBase = '') => buildHoverMessage(b, 'C:\\repo\\a.py', webBase, 'C:\\repo', 'python')!.value;

/** The command: links in rendered Markdown (what VS Code would let a click run). */
const commandLinks = (markdown: string) => [...markdown.matchAll(/\]\((command:[^)\s]*)\)/g)].map((m) => m[1].split('?')[0]);

suite('Git Blame Annotations: the hover cannot be used to run commands', () => {
  test('a commit message with a command: link stays text (bug: upstream trusted every command link)', () => {
    const md = hoverText(blame({ summary: 'innocent [click me](command:workbench.action.terminal.new) <b>x</b> $(alert)' }));
    const links = commandLinks(md);
    assert.ok(!links.includes('command:workbench.action.terminal.new'), md);
    assert.ok(links.every((l) => HOVER_COMMANDS.includes(l.slice('command:'.length))), links.join(', '));
  });

  test('an author name or e-mail cannot add a link', () => {
    const md = hoverText(blame({ author: 'Eve](command:workbench.action.terminal.new)[x', mail: '<e@x.com>)[y](command:evil>' }));
    assert.ok(!commandLinks(md).some((l) => l === 'command:workbench.action.terminal.new' || l === 'command:evil'), md);
  });

  test('only this feature\'s commands are trusted, not every command', () => {
    const content = buildHoverMessage(blame(), 'a.py', '', '/repo', 'python') as MarkdownString;
    assert.deepStrictEqual(content.isTrusted as unknown, { enabledCommands: HOVER_COMMANDS });
  });

  test('a ")" in a commit message does not cut the commit link short (its arguments are fully encoded)', () => {
    const md = hoverText(blame({ summary: 'fix (part 1) it\'s done!' }));
    const viewCommit = md.match(/\(command:aspycharm\.gitBlame\.viewCommit\?([^)]*)\)/);
    assert.ok(viewCommit, md);
    const args = JSON.parse(decodeURIComponent(viewCommit![1]));
    assert.deepStrictEqual(args, [COMMIT, 'fix (part 1) it\'s done!', 'C:\\repo\\a.py', 'C:\\repo']);
  });

  test('a remote URL cannot add Markdown or a non-web link to the hover', () => {
    assert.strictEqual(safeLinkTarget('command:workbench.action.terminal.new'), '');
    assert.strictEqual(safeLinkTarget('javascript:alert(1)'), '');
    assert.strictEqual(safeLinkTarget('https://h/a)[x](command:y'), 'https://h/a%29%5Bx%5D%28command:y');
    const md = hoverText(blame(), 'https://example.com/o/r)[x](command:workbench.action.terminal.new');
    assert.ok(!commandLinks(md).includes('command:workbench.action.terminal.new'), md);
  });

  test('Markdown escaping keeps the text readable', () => {
    assert.strictEqual(escapeMarkdown('a_b *c* [d](e) $(f)'), 'a\\_b \\*c\\* \\[d\\]\\(e\\) \\$\\(f\\)');
  });
});

suite('Git Blame Annotations: git commands', () => {
  test('a ref that git would read as an option is refused', () => {
    assert.throws(() => checkRef('--output=x.txt'));
    assert.throws(() => checkRef('a b'));
    assert.strictEqual(checkRef('HEAD~1'), 'HEAD~1');
    assert.strictEqual(checkRef(COMMIT), COMMIT);
  });

  test('git output is decoded once, so a character split between two chunks stays whole (bug: Cătălin became C��t��lin)', async () => {
    const bytes = Buffer.from('author Cătălin Ionuț\n', 'utf8');
    const cut = bytes.indexOf(Buffer.from('ă', 'utf8')) + 1; // in the middle of "ă"
    const text = await readAll(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)]));
    assert.strictEqual(text, 'author Cătălin Ionuț\n');
  });

  test('parses git blame --incremental', () => {
    const out = [
      `${COMMIT} 1 1 2`, 'author Ana Pop', 'author-mail <ana@example.com>', 'author-time 1700000000', 'summary First',
      'filename a.py',
      `${'b'.repeat(40)} 2 3 1`, 'author Ion', 'author-mail <ion@example.com>', 'author-time 1700001000', 'summary Second',
      `previous ${COMMIT} a.py`, 'filename a.py',
      '',
    ].join('\r\n');
    const { totalLines, blames } = parseBlames(out);
    assert.strictEqual(totalLines, 3);
    assert.deepStrictEqual(blames.map((b) => [b.author, b.summary, b.lines, b.previousCommit, b.filename]), [
      ['Ana Pop', 'First', [[1, 2, 1]], undefined, 'a.py'],
      ['Ion', 'Second', [[3, 1, 2]], COMMIT, 'a.py'],
    ]);
  });

  test('lines not committed yet are recognised in SHA-256 repositories too (64 zeros, not 40)', () => {
    assert.ok(!isCommitted('0'.repeat(40)));
    assert.ok(!isCommitted('0'.repeat(64)));
    assert.ok(isCommitted(COMMIT));
    const { blames } = parseBlames([`${'0'.repeat(64)} 1 1 1`, 'author Not Committed Yet', 'filename a.py', ''].join('\n'));
    assert.strictEqual(blames[0].commited, false);
  });

  test('line history compares Windows paths without case (bug: d:\\x and D:/x differed, so every entry looked renamed)', () => {
    assert.ok(isSamePath('d:\\repo\\a.py', 'D:\\repo\\a.py', 'win32'));
    assert.ok(isSamePath('d:\\repo\\a.py', 'd:\\repo\\.\\a.py', 'win32'));
    assert.ok(!isSamePath('d:\\repo\\a.py', 'd:\\repo\\b.py', 'win32'));
    assert.ok(!isSamePath('/repo/A.py', '/repo/a.py', 'linux'));
  });

  test('web links from remotes keep the port and drop the password (bug: http://host:3000 lost :3000)', () => {
    assert.strictEqual(toWebBaseUrl('http://192.168.3.241:3000/catalinpop/VSCodeAsPycharm.git'), 'http://192.168.3.241:3000/catalinpop/VSCodeAsPycharm');
    assert.strictEqual(toWebBaseUrl('https://user:secret@github.com/o/r.git'), 'https://github.com/o/r');
    assert.strictEqual(toWebBaseUrl('git@github.com:o/r.git'), 'https://github.com/o/r');
    assert.strictEqual(toWebBaseUrl('ssh://git@gitlab.com:2222/o/r.git'), 'https://gitlab.com/o/r');
    assert.strictEqual(toWebBaseUrl('file:///C:/repos/r'), '');
    assert.deepStrictEqual(buildCommitUrl('https://gitlab.com/o/r', 'abc'), ['https://gitlab.com/o/r/-/commit/abc', 'GitLab']);
    assert.deepStrictEqual(buildCommitUrl('http://192.168.3.241:3000/o/r', 'abc'), ['http://192.168.3.241:3000/o/r/commit/abc', '']);
  });
});

suite('Git Blame Annotations: text', () => {
  test('relative dates', () => {
    const now = 1_700_000_000;
    assert.strictEqual(formatRelative(now - 3, now), 'just now');
    assert.strictEqual(formatRelative(now - 45, now), '45 seconds ago');
    assert.strictEqual(formatRelative(now - 60, now), '1 minute ago');
    assert.strictEqual(formatRelative(now - 3 * 3600, now), '3 hours ago');
    assert.strictEqual(formatRelative(now - 86400, now), '1 day ago');
    assert.strictEqual(formatRelative(now - 15 * 86400, now), '2 weeks ago');
    assert.strictEqual(formatRelative(now - 400 * 86400, now), '1 year ago');
    assert.strictEqual(formatRelative(now + 100, now), 'just now');
  });

  test('an emoji counts as one wide character and is never cut in half (bug: counted as two narrow ones)', () => {
    assert.deepStrictEqual(getTextWidth('a😀b'), { width: 4, widths: [1, 2, 1] });
    const { widths } = getTextWidth('😀😀😀');
    assert.strictEqual(truncateText('😀😀😀', 5, widths), '😀😀');
  });
});

suite('Git Blame Annotations: wired into the extension', () => {
  test('commands, menus and settings are ours (upstream\'s git.blame.* would clash with the original extension)', async () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const ours = Object.values(GIT_BLAME_COMMANDS);
    const all = await commands.getCommands(true);
    for (const id of ours) {
      assert.ok(all.includes(id), `${id} is registered`);
    }
    const contributed = pkg.commands.map((c: { command: string }) => c.command);
    assert.ok(!contributed.some((c: string) => c.startsWith('git.blame.')));
    assert.ok(pkg.menus['editor/lineNumber/context'].some((m: { command: string }) => m.command === GIT_BLAME_COMMANDS.show));
    const settings = Object.keys(Object.assign({}, ...pkg.configuration.map((c: { properties: object }) => c.properties)));
    assert.ok(!settings.some((k) => k.startsWith('gitblame.')));
    assert.ok(settings.includes('aspycharm.gitBlame.dateFormatStyle'));
  });

  test('Escape is left alone (bug: upstream\'s Escape closed the annotations instead of the suggestion list)', () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const escape = pkg.keybindings.filter((k: { key: string; command: string }) => k.key === 'escape' && k.command.includes('gitBlame'));
    assert.deepStrictEqual(escape, []);
    const toggle = pkg.keybindings.find((k: { command: string }) => k.command === GIT_BLAME_COMMANDS.toggle);
    assert.strictEqual(toggle.key, 'ctrl+alt+b');
  });

  test('Ctrl+Alt+B is taken only in file editors, not in Output or the Debug Console (bug: it hid VS Code\'s side bar toggle there for nothing)', () => {
    const pkg = extensions.getExtension('catalinpop.aspycharm')!.packageJSON.contributes;
    const toggle = pkg.keybindings.find((k: { command: string }) => k.command === GIT_BLAME_COMMANDS.toggle);
    assert.strictEqual(toggle.when, 'editorTextFocus && (resourceScheme == file || resourceScheme == git)');
  });

  test('the licence of the ported code ships with it', () => {
    const ext = extensions.getExtension('catalinpop.aspycharm')!;
    const licence = fs.readFileSync(path.join(ext.extensionPath, 'resources', 'gitBlame', 'LICENSE.vscode-gitblame-annotations'), 'utf8');
    assert.ok(licence.includes('MIT License') && licence.includes('lkqm'));
  });
});

suite('Git Blame Annotations: in an editor', function () {
  this.timeout(30000);
  let repo = '';
  let file = '';

  const git = (...args: string[]) => exec(repo, ['-c', 'user.name=Ana Pop', '-c', 'user.email=ana@example.com',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args]);

  suiteSetup(async () => {
    // realpath: the test copy of VS Code and git must agree on the folder's name (no 8.3 short names).
    repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitblame-repo-')));
    file = path.join(repo, 'a.py');
    await git('init', '-q');
    fs.writeFileSync(file, 'one = 1\ntwo = 2\n');
    await git('add', 'a.py');
    await git('commit', '-q', '-m', 'First [commit](command:workbench.action.terminal.new)');
    fs.writeFileSync(file, 'one = 1\ntwo = 2\nthree = 3\n');
    await exec(repo, ['-c', 'user.name=Cătălin Ionuț', '-c', 'user.email=c@example.com', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-am', 'Second']);
  });

  teardown(async () => {
    await commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('a ref like --output=<file> does not reach git (bug: upstream\'s git log wrote the file)', async () => {
    const target = path.join(repo, 'written.txt');
    await assert.rejects(getFileRevisionNumbers(repo, 'a.py', `--output=${target}`));
    assert.ok(!fs.existsSync(target));
  });

  test('Toggle shows each line\'s date and author, and the hover shows the commit', async () => {
    const document = await workspace.openTextDocument(Uri.file(file));
    await window.showTextDocument(document);
    await commands.executeCommand(GIT_BLAME_COMMANDS.toggle);
    assert.ok(isBlameShown(document.uri));
    const titles = blameTitles(document.uri)!;
    assert.strictEqual(titles.length, 4); // 3 lines + the empty last line
    assert.ok(titles[0].includes('Ana Pop') && titles[1].includes('Ana Pop'), titles.join(' | '));
    assert.ok(titles[2].includes('Cătălin Ionuț'), titles.join(' | '));
    assert.strictEqual(titles[3], '');

    const hovers = await commands.executeCommand<Hover[]>('vscode.executeHoverProvider', document.uri, new Position(0, 0));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : c.value))).join('\n');
    assert.ok(text.includes('Ana Pop') && text.includes('First'), text);
    assert.ok(!commandLinks(text).includes('command:workbench.action.terminal.new'), text);

    await commands.executeCommand(GIT_BLAME_COMMANDS.toggle);
    assert.ok(!isBlameShown(document.uri));
  });

  test('a file with unsaved edits is blamed as edited: new lines are not committed and the rest stay in place (bug: shifted)', async () => {
    const document = await workspace.openTextDocument(Uri.file(file));
    const editor = await window.showTextDocument(document);
    await editor.edit((e) => e.insert(new Position(0, 0), 'zero = 0\n'));
    assert.ok(document.isDirty);
    await commands.executeCommand(GIT_BLAME_COMMANDS.show);
    const titles = blameTitles(document.uri)!;
    assert.strictEqual(titles[0], '', titles.join(' | '));
    assert.ok(titles[1].includes('Ana Pop') && titles[3].includes('Cătălin Ionuț'), titles.join(' | '));
    await commands.executeCommand(GIT_BLAME_COMMANDS.hide);
    assert.ok(!isBlameShown(document.uri));
  });

  test('Close Annotations while git is still blaming wins (bug: the annotations came back and could not be closed)', async () => {
    const document = await workspace.openTextDocument(Uri.file(file));
    await window.showTextDocument(document);
    const showing = commands.executeCommand(GIT_BLAME_COMMANDS.show); // runs until it waits for git
    await commands.executeCommand(GIT_BLAME_COMMANDS.hide);
    await showing;
    assert.ok(!isBlameShown(document.uri));
    assert.strictEqual(blameTitles(document.uri), undefined);
    await commands.executeCommand(GIT_BLAME_COMMANDS.toggle); // and it can be shown again
    assert.ok(isBlameShown(document.uri));
    await commands.executeCommand(GIT_BLAME_COMMANDS.hide);
  });

  test('back to the saved text (Revert, Undo, reloaded after a pull) is blamed again (bug: edited lines stayed blank until saved)', async () => {
    const document = await workspace.openTextDocument(Uri.file(file));
    const editor = await window.showTextDocument(document);
    await commands.executeCommand(GIT_BLAME_COMMANDS.show);
    await editor.edit((e) => e.insert(new Position(0, 0), 'x'));
    await waitFor(() => blameTitles(document.uri)?.[0] === '');
    await commands.executeCommand('workbench.action.files.revert');
    assert.ok(!document.isDirty);
    await waitFor(() => blameTitles(document.uri)?.[0].includes('Ana Pop') ?? false);
    await commands.executeCommand(GIT_BLAME_COMMANDS.hide);
  });

  test('a file outside any Git repository says so (bug: Ctrl+Alt+B did nothing, silently)', async () => {
    const outside = path.join(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gitblame-none-'))), 'b.py');
    fs.writeFileSync(outside, 'x = 1\n');
    const document = await workspace.openTextDocument(Uri.file(outside));
    await window.showTextDocument(document);
    const shown: string[] = [];
    const original = window.showInformationMessage;
    Object.assign(window, { showInformationMessage: async (m: string) => { shown.push(m); return undefined; } });
    try {
      await commands.executeCommand(GIT_BLAME_COMMANDS.toggle);
    } finally {
      Object.assign(window, { showInformationMessage: original });
    }
    assert.ok(!isBlameShown(document.uri));
    assert.deepStrictEqual(shown, ['Annotate with Git Blame: b.py is not in a Git repository, or git was not found on PATH.']);
  });
});

async function waitFor(check: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`waited ${ms} ms in vain`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
