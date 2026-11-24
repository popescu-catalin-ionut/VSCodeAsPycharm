// Git Blame Annotations: the git commands and the parsing of their output.
// Port of lkqm/vscode-gitblame-annotations 0.5.3 (MIT, licence in resources/gitBlame/), src/git.ts.
// Changes: refs and commit ids are checked so they cannot be read as git options, output is decoded as UTF-8 once
// (not per chunk), a document's unsaved text can be blamed (--contents -), and web links keep the port.
import * as child_process from 'child_process';
import * as path from 'path';
import { Uri } from 'vscode';

export const UNCOMMITTED = '0000000000000000000000000000000000000000';

/** git marks lines not committed yet with an id of zeros: 40 of them, or 64 in a SHA-256 repository. */
export function isCommitted(commit: string): boolean {
  return !/^0+$/.test(commit);
}

export interface Blame {
  line: number;
  sourceLine: number;
  author: string;
  mail: string;
  commit: string;
  commitNumber?: number;
  summary: string;
  timestamp: number;
  commited: boolean;
  title: string;
  filename?: string;
  previousCommit?: string;
  previousFile?: string;
}

interface CommitBlame extends Omit<Blame, 'line' | 'sourceLine'> {
  lines: [number, number, number][];
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: string;
}

export interface BlameLine {
  blame: Blame;
  lineText: string;
}

export interface LineParentMapping {
  kind: 'A' | 'M' | 'R';
  previousFile?: string;
  previousLine?: number;
}

/**
 * A ref or commit id we pass to git as an argument. One that starts with "-" would be read as an option
 * (`git log --output=<file>` writes a file), so it is refused.
 */
export function checkRef(ref: string): string {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref)) {
    throw new Error(`Not a git revision: ${JSON.stringify(ref)}`);
  }
  return ref;
}

/** All of a stream's bytes, decoded as UTF-8 at the end, so a character split across two chunks stays whole. */
export function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (data: Buffer | string) => chunks.push(typeof data === 'string' ? Buffer.from(data) : data));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Runs git (no shell) in workDir; input, if given, is written to its stdin. */
export function exec(workDir: string, args: string[], input?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const git = child_process.spawn('git', args, { cwd: workDir, windowsHide: true });
    const stdout = readAll(git.stdout);
    const stderr = readAll(git.stderr);
    git.on('error', reject);
    git.on('close', async (code) => {
      const [out, err] = await Promise.all([stdout, stderr]);
      if (code !== 0) {
        reject(new Error(`Git command failed with code ${code}: ${err}`));
        return;
      }
      resolve(out);
    });
    git.stdin.on('error', () => undefined); // git may exit before reading everything; the exit code tells.
    git.stdin.end(input ?? '');
  });
}

/** The repository's top folder for a file, or "" when it is not in a repository. */
export async function getGitRepository(filePath: string): Promise<string> {
  try {
    const result = await exec(path.dirname(filePath), ['rev-parse', '--show-toplevel']);
    return path.normalize(result.trim());
  } catch (error) {
    return '';
  }
}

/** Blame for every line of a file at ref, or of the working copy; contents, if given, is blamed instead of the file on disk. */
export async function getBlames(workDir: string, file: string, ref?: string, contents?: string): Promise<Blame[]> {
  const args = ['blame', '--incremental'];
  if (ref) {
    args.push(checkRef(ref));
  } else if (contents !== undefined) {
    args.push('--contents', '-');
  }
  args.push('--', file);
  const blame = await exec(workDir, args, ref ? undefined : contents);
  const { totalLines, blames } = parseBlames(blame);
  return toBlames(totalLines, blames);
}

/** The commits that changed the file, numbered from 1 (the oldest). */
export async function getFileRevisionNumbers(workDir: string, file: string, ref?: string): Promise<Map<string, number>> {
  const args = ['log', '--follow', '--format=%H'];
  if (ref) {
    args.push(checkRef(ref));
  }
  args.push('--', file);

  const history = await exec(workDir, args);
  const commits = history
    .split(/\r?\n/)
    .map((commit) => commit.trim())
    .filter((commit) => commit);

  const commitNumbers = new Map<string, number>();
  commits.reverse().forEach((commit, index) => {
    commitNumbers.set(commit, index + 1);
  });
  return commitNumbers;
}

/** Blame and text of one line. */
export async function getBlameLine(workDir: string, file: string, line: number, ref?: string): Promise<BlameLine | undefined> {
  if (line < 1) {
    return undefined;
  }

  const args = ['blame', '--line-porcelain', '-L', `${line},${line}`];
  if (ref) {
    args.push(checkRef(ref));
  }
  args.push('--', file);

  const blame = await exec(workDir, args);
  return parseBlameLine(blame);
}

/** The files a commit changed against another commit (or tree). */
export async function getChanges(workDir: string, commitId1: string, commitId2?: string): Promise<Change[]> {
  const args = ['diff-tree', '-r', '--name-status', '-z', '--diff-filter=ADMR', '--find-renames', checkRef(commitId1)];
  if (commitId2) {
    args.push(checkRef(commitId2));
  }
  const changes = await exec(workDir, args);
  return parseChanges(workDir, changes);
}

/** Maps a line in a commit to the corresponding line in its parent. */
export async function getLineParentMapping(
  workDir: string, parentCommitId: string, commitId: string, files: string[], line: number,
): Promise<LineParentMapping | undefined> {
  if (line < 1) {
    return undefined;
  }

  const diff = await exec(workDir, [
    'diff', '--no-color', '--no-ext-diff', '--find-renames', '--unified=0',
    checkRef(parentCommitId), checkRef(commitId), '--', ...files,
  ]);
  return parseLineParentMapping(diff, line);
}

/** The first parent of a commit, or "" for a root commit. */
export async function getParentCommitId(workDir: string, commitId: string): Promise<string> {
  try {
    const commit = await exec(workDir, ['rev-parse', `${checkRef(commitId)}^`]);
    const parentId = commit.trim();
    return parentId === commitId ? '' : parentId;
  } catch (error) {
    return '';
  }
}

/** All parents of a commit. */
export async function getParentCommitIds(workDir: string, commitId: string): Promise<string[]> {
  try {
    const commit = await exec(workDir, ['rev-list', '--parents', '-n', '1', checkRef(commitId)]);
    return commit.trim().split(/\s+/).filter((p) => p).slice(1);
  } catch (error) {
    return [];
  }
}

/** The id of the empty tree (what a root commit is compared with). */
export async function getEmptyTree(workDir: string): Promise<string> {
  const result = await exec(workDir, ['hash-object', '-t', 'tree', '--stdin'], '');
  return result.trim();
}

/** "untracked", "index_add" (added, never committed) or "tracked". */
export async function getFileStatus(workDir: string, filename: string): Promise<string> {
  const result = await exec(workDir, ['status', '--short', '--', filename]);
  if (!result) {
    return 'tracked';
  }
  const statusCode = result.substring(0, 1).trim();
  if (statusCode === '?') {
    return 'untracked';
  } else if (statusCode === 'A') {
    return 'index_add';
  }
  return 'tracked';
}

export async function getRemoteUrl(workDir: string): Promise<string> {
  for (const args of [['remote', 'get-url', '--push', 'origin'], ['remote', 'get-url', 'origin']]) {
    try {
      const url = (await exec(workDir, args)).trim();
      if (url) {
        return url;
      }
    } catch (_) {
      // try the next way
    }
  }
  return '';
}

/** The web page of a repository from its remote URL (scp-like, ssh:// or http(s)), without user name or password. */
export function toWebBaseUrl(remoteUrl: string): string {
  if (!remoteUrl) {
    return '';
  }
  const scpLike = /^(?:[^@/]+)@([^:/]+):(.+)$/; // git@github.com:owner/repo.git
  const stripGit = (p: string) => (p.endsWith('.git') ? p.slice(0, -4) : p);

  try {
    const scp = remoteUrl.match(scpLike);
    if (scp) {
      return `https://${scp[1]}/${stripGit(scp[2]).replace(/^\/+/, '')}`;
    }

    const url = new URL(remoteUrl.replace(/^git\+/, ''));
    if (url.protocol === 'ssh:') {
      // The ssh port is not the web server's port.
      return `https://${url.hostname}/${stripGit(url.pathname.replace(/^\/+/, ''))}`;
    }
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.protocol}//${url.host}${stripGit(url.pathname)}`;
    }
    return '';
  } catch (_) {
    return '';
  }
}

export async function getRepoWebBase(workDir: string): Promise<string> {
  return toWebBaseUrl(await getRemoteUrl(workDir));
}

const PLATFORMS: Record<string, string> = {
  'github.com': 'GitHub', 'gitlab.com': 'GitLab', 'bitbucket.org': 'Bitbucket', 'gitee.com': 'Gitee',
};

/** The commit's web page and the platform's name ("" when not known). */
export function buildCommitUrl(base: string, commitId: string): [string, string] {
  if (!base || !commitId) {
    return ['', ''];
  }

  let platform = '';
  let commitUrl = '';
  try {
    const host = new URL(base).hostname.toLowerCase();
    platform = PLATFORMS[host] ?? '';
    const baseHref = base.replace(/\/$/, '');
    if (platform === 'GitLab') {
      commitUrl = `${baseHref}/-/commit/${commitId}`;
    } else if (platform === 'Bitbucket') {
      commitUrl = `${baseHref}/commits/${commitId}`;
    } else {
      commitUrl = `${baseHref}/commit/${commitId}`; // GitHub, Gitea / Forgejo, Azure DevOps and most others
    }
  } catch (_) {
    return ['', ''];
  }
  return [commitUrl, platform];
}

/** Parses `git blame --incremental`. */
export function parseBlames(blame: string): { totalLines: number; blames: CommitBlame[] } {
  const blames: CommitBlame[] = [];
  const lines = blame.split('\n');
  const newCommitBlame = (commit: string, first: [number, number, number]): CommitBlame => ({
    lines: [first],
    commit,
    author: '',
    mail: '',
    summary: '',
    timestamp: 0,
    commited: isCommitted(commit),
    title: '',
    filename: undefined,
    previousCommit: undefined,
    previousFile: undefined,
  });

  let currentBlock: CommitBlame | undefined;
  const commitToBlock = new Map<string, CommitBlame>();
  let newBlock = true;
  let totalLines = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (newBlock) {
      const parts = line.split(' ');
      const commit = parts[0];
      if (commit === '') {
        continue;
      }
      const sourceLineNumber = parseInt(parts[1], 10);
      const lineNumber = parseInt(parts[2], 10);
      const lineCount = parseInt(parts[3], 10);
      const commitBlock = commitToBlock.get(commit);
      if (commitBlock) {
        commitBlock.lines.push([lineNumber, lineCount, sourceLineNumber]);
        currentBlock = commitBlock;
      } else {
        currentBlock = newCommitBlame(commit, [lineNumber, lineCount, sourceLineNumber]);
        blames.push(currentBlock);
        commitToBlock.set(commit, currentBlock);
      }
      newBlock = false;
      totalLines = Math.max(totalLines, lineNumber + lineCount - 1);
    } else if (!currentBlock) {
      continue;
    } else if (line.startsWith('author ')) {
      currentBlock.author = line.substring(7);
    } else if (line.startsWith('author-mail ')) {
      currentBlock.mail = line.substring(12);
    } else if (line.startsWith('author-time ')) {
      currentBlock.timestamp = parseInt(line.substring(12), 10);
    } else if (line.startsWith('summary ')) {
      currentBlock.summary = line.substring(8);
    } else if (line.startsWith('previous ')) {
      const previous = line.substring(9);
      const firstSpaceIndex = previous.indexOf(' ');
      if (firstSpaceIndex > 0 && !currentBlock.previousCommit) {
        currentBlock.previousCommit = previous.substring(0, firstSpaceIndex);
        currentBlock.previousFile = previous.substring(firstSpaceIndex + 1);
      }
    } else if (line.startsWith('filename ')) {
      currentBlock.filename = line.substring(9);
      newBlock = true;
    }
  }
  return { totalLines, blames };
}

function parseBlameLine(raw: string): BlameLine | undefined {
  const lines = raw.split('\n').map((l) => l.replace(/\r$/, ''));
  const header = lines.find((line) => line.trim()) ?? '';
  const headerParts = header.split(' ');
  if (headerParts.length < 3) {
    return undefined;
  }

  const commit = headerParts[0];
  const blame: Blame = {
    line: parseInt(headerParts[2], 10),
    sourceLine: parseInt(headerParts[1], 10),
    author: '',
    mail: '',
    commit,
    summary: '',
    timestamp: 0,
    commited: isCommitted(commit),
    title: '',
  };
  let lineText = '';

  for (const line of lines.slice(1)) {
    if (line.startsWith('author ')) {
      blame.author = line.substring(7);
    } else if (line.startsWith('author-mail ')) {
      blame.mail = line.substring(12);
    } else if (line.startsWith('author-time ')) {
      blame.timestamp = parseInt(line.substring(12), 10);
    } else if (line.startsWith('summary ')) {
      blame.summary = line.substring(8);
    } else if (line.startsWith('previous ')) {
      const previous = line.substring(9);
      const firstSpaceIndex = previous.indexOf(' ');
      if (firstSpaceIndex > 0) {
        blame.previousCommit = previous.substring(0, firstSpaceIndex);
        blame.previousFile = previous.substring(firstSpaceIndex + 1);
      }
    } else if (line.startsWith('filename ')) {
      blame.filename = line.substring(9);
    } else if (line.startsWith('\t')) {
      lineText = line.substring(1);
      break;
    }
  }

  return { blame, lineText };
}

function parseLineParentMapping(raw: string, line: number): LineParentMapping | undefined {
  const lines = raw.split(/\r?\n/);
  let previousFile: string | undefined;
  let currentFile: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const diffLine = lines[i];
    if (diffLine.startsWith('--- ')) {
      previousFile = parseDiffFileName(diffLine.substring(4), 'a');
    } else if (diffLine.startsWith('+++ ')) {
      currentFile = parseDiffFileName(diffLine.substring(4), 'b');
    } else if (diffLine.startsWith('rename from ')) {
      previousFile = diffLine.substring(12);
    } else if (diffLine.startsWith('rename to ')) {
      currentFile = diffLine.substring(10);
    } else if (diffLine.startsWith('@@ ')) {
      const hunk = parseDiffHunkHeader(diffLine);
      if (!hunk || hunk.newCount === 0) {
        continue;
      }
      const newEnd = hunk.newStart + hunk.newCount - 1;
      if (line < hunk.newStart || line > newEnd) {
        continue;
      }
      return mapLineInHunk(lines, i + 1, hunk, line, previousFile, currentFile);
    }
  }

  return undefined;
}

function mapLineInHunk(
  lines: string[],
  startIndex: number,
  hunk: { oldStart: number; newStart: number },
  targetLine: number,
  previousFile: string | undefined,
  currentFile: string | undefined,
): LineParentMapping {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  const pendingOldLines: number[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) {
      break;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    if (line.startsWith('-')) {
      pendingOldLines.push(oldLine);
      oldLine++;
      continue;
    }
    if (line.startsWith('+')) {
      const previousLine = pendingOldLines.shift();
      if (newLine === targetLine) {
        if (previousLine) {
          return { kind: isRename(previousFile, currentFile) ? 'R' : 'M', previousFile, previousLine };
        }
        return { kind: 'A', previousFile };
      }
      newLine++;
      continue;
    }

    const previousLine = oldLine;
    if (newLine === targetLine) {
      return { kind: isRename(previousFile, currentFile) ? 'R' : 'M', previousFile, previousLine };
    }
    oldLine++;
    newLine++;
  }

  return { kind: 'A', previousFile };
}

function parseDiffFileName(raw: string, prefix: 'a' | 'b'): string | undefined {
  if (raw === '/dev/null') {
    return undefined;
  }
  const fileName = raw.startsWith(`${prefix}/`) ? raw.substring(2) : raw;
  const tabIndex = fileName.indexOf('\t');
  return tabIndex >= 0 ? fileName.substring(0, tabIndex) : fileName;
}

function parseDiffHunkHeader(line: string): { oldStart: number; newStart: number; newCount: number } | undefined {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function isRename(previousFile: string | undefined, currentFile: string | undefined): boolean {
  return !!previousFile && !!currentFile && previousFile !== currentFile;
}

/** Parses `git diff-tree --name-status -z`. */
function parseChanges(workDir: string, raw: string): Change[] {
  let index = 0;
  const result: Change[] = [];
  const segments = raw.trim().split('\x00').filter((s) => s);
  const toUri = (p: string) => Uri.file(path.isAbsolute(p) ? p : path.join(workDir, p));

  segmentsLoop:
  while (index < segments.length - 1) {
    const change = segments[index++];
    const resourcePath = segments[index++];
    if (!change || !resourcePath) {
      break;
    }

    const originalUri = toUri(resourcePath);
    let uri = originalUri;
    let renameUri = originalUri;
    let status = 'untracked';

    // A rename comes with a score (R100); only the first character counts.
    switch (change[0]) {
      case 'A':
        status = 'index_added';
        break;
      case 'M':
        status = 'modified';
        break;
      case 'D':
        status = 'deleted';
        break;
      case 'R': {
        // A rename has two paths; the second is the new name.
        const newPath = segments[index++];
        if (!newPath) {
          break;
        }
        status = 'index_renamed';
        uri = renameUri = toUri(newPath);
        break;
      }
      default:
        break segmentsLoop;
    }

    result.push({ status, uri, originalUri, renameUri });
  }

  return result;
}

function toBlames(totalLines: number, commitBlames: CommitBlame[]): Blame[] {
  const blames: Blame[] = new Array(totalLines);
  commitBlames.forEach(({ lines, ...commitInfo }) => {
    lines.forEach(([start, length, sourceStart]) => {
      for (let i = start - 1; i < start + length - 1; i++) {
        blames[i] = { line: i + 1, sourceLine: sourceStart + (i - (start - 1)), ...commitInfo };
      }
    });
  });
  return blames;
}
