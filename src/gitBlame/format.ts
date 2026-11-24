// Git Blame Annotations: settings, text formatting and URIs.
// Port of lkqm/vscode-gitblame-annotations 0.5.3 (MIT, licence in resources/gitBlame/), src/utils.ts.
// Changes: relative dates without the timeago.js dependency, Markdown escaping for the hover, emoji widths by code
// point, settings under aspycharm.gitBlame.
import * as path from 'path';
import { TextDocumentContentChangeEvent, Uri, workspace } from 'vscode';
import { Blame, Change, UNCOMMITTED } from './git';

export const CONFIG_SECTION = 'aspycharm.gitBlame';

// keep the defaults in sync with package.json
export type DateFormatStyle = 'YYYY-MM-DD' | 'Y/M/D' | 'DD.MM.YYYY' | 'relative';
export type AbsoluteDateFormatStyle = Exclude<DateFormatStyle, 'relative'>;
export const VALID_DATEFORMATSTYLES: DateFormatStyle[] = ['YYYY-MM-DD', 'Y/M/D', 'DD.MM.YYYY', 'relative'];
export const defaultDateFormatStyle: AbsoluteDateFormatStyle = 'Y/M/D';

export type AuthorNameStyle = 'full' | 'first' | 'last';
export const VALID_AUTHORNAMESTYLES: AuthorNameStyle[] = ['full', 'first', 'last'];
export const defaultAuthorNameStyle: AuthorNameStyle = 'full';

export interface GitBlameConfig {
  mergeCommitLines: boolean;
  highlightChangedLines: boolean;
  showCommitNumber: boolean;
  dateFormatStyle: DateFormatStyle;
  authorNameStyle: AuthorNameStyle;
}

function oneOf<T extends string>(raw: string | undefined, valid: T[], fallback: T): T {
  return valid.includes(raw as T) ? (raw as T) : fallback;
}

export function getGitBlameConfig(): GitBlameConfig {
  const cfg = workspace.getConfiguration(CONFIG_SECTION);
  return {
    mergeCommitLines: cfg.get('mergeCommitLines', false),
    highlightChangedLines: cfg.get('highlightChangedLines', false),
    showCommitNumber: cfg.get('showCommitNumber', false),
    dateFormatStyle: oneOf(cfg.get<string>('dateFormatStyle'), VALID_DATEFORMATSTYLES, defaultDateFormatStyle),
    authorNameStyle: oneOf(cfg.get<string>('authorNameStyle'), VALID_AUTHORNAMESTYLES, defaultAuthorNameStyle),
  };
}

const RELATIVE_UNITS: [string, number][] = [
  ['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 365 / 7 / 12], ['month', 12], ['year', Infinity],
];

/** "just now", "5 minutes ago", "1 day ago", "3 weeks ago", ... (the steps timeago.js uses). */
export function formatRelative(timestamp: number, now: number = Date.now() / 1000): string {
  let value = Math.max(0, now - timestamp);
  let unit = 0;
  while (value >= RELATIVE_UNITS[unit][1]) {
    value /= RELATIVE_UNITS[unit][1];
    unit++;
  }
  const n = Math.floor(value);
  if (unit === 0 && n < 10) {
    return 'just now';
  }
  const name = RELATIVE_UNITS[unit][0];
  return `${n} ${name}${n === 1 ? '' : 's'} ago`;
}

/** @param timestamp seconds since 1970 */
export function formatDate(timestamp: number, style: DateFormatStyle): string {
  if (style === 'relative') {
    return formatRelative(timestamp);
  }
  const map: Record<AbsoluteDateFormatStyle, [string, Intl.DateTimeFormatOptions]> = {
    'YYYY-MM-DD': ['en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }],
    'Y/M/D': ['zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }],
    'DD.MM.YYYY': ['de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }],
  };
  const [locale, options] = map[style];
  return new Intl.DateTimeFormat(locale, options).format(new Date(timestamp * 1000));
}

export function formatDateTime(timestamp: number, style: AbsoluteDateFormatStyle): string {
  const date = new Date(timestamp * 1000);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${formatDate(timestamp, style)} ${hours}:${minutes}`;
}

export function formatAuthor(name: string, style: AuthorNameStyle): string {
  if (!name || name.trim() === '') {
    return '';
  }
  const parts = name.trim().split(/\s+/);
  switch (style) {
    case 'first': return parts[0];
    case 'last': return parts[parts.length - 1];
    default: return name;
  }
}

/** Text shown as is in Markdown: no links, emphasis, HTML or $(icon) from commit messages and author names. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~$&]/g, '\\$&');
}

/** An http(s) URL usable as a Markdown link target, or "" (anything else, such as a command: link, is refused). */
export function safeLinkTarget(url: string): string {
  if (!/^https?:\/\/[^\s]+$/i.test(url)) {
    return '';
  }
  return url.replace(/[()[\]<>"'\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function toMultiFileDiffEditorUris(change: Change, originalRef: string, modifiedRef: string): { originalUri: Uri | undefined; modifiedUri: Uri | undefined } {
  switch (change.status) {
    case 'index_added':
      return { originalUri: undefined, modifiedUri: toGitUri(change.uri, modifiedRef) };
    case 'deleted':
      return { originalUri: toGitUri(change.uri, originalRef), modifiedUri: undefined };
    case 'index_renamed':
      return { originalUri: toGitUri(change.originalUri, originalRef), modifiedUri: toGitUri(change.uri, modifiedRef) };
    default:
      return { originalUri: toGitUri(change.uri, originalRef), modifiedUri: toGitUri(change.uri, modifiedRef) };
  }
}

/** A URI of VS Code's built-in Git extension for the file at ref. */
export function toGitUri(uri: Uri, ref: string): Uri {
  const params = { path: uri.fsPath, submoduleOf: '', ref };
  return uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify(params) });
}

/** Like toGitUri, with the short commit id in the tab title and the repository folder kept in the query. */
export function toNamedGitUri(fileName: string, ref: string, repositoryRoot: string): Uri {
  const uri = toGitUri(Uri.file(fileName), ref);
  const parsedPath = path.posix.parse(uri.path);
  const displayPath = path.posix.join(parsedPath.dir, `${parsedPath.base} (${ref.substring(0, 8)})`);
  const params = JSON.parse(uri.query) as { path?: string; ref?: string; submoduleOf?: string };
  return uri.with({ path: displayPath, query: JSON.stringify({ ...params, repositoryRoot }) });
}

export function getRepositoryRelativePath(repositoryRoot: string, fileName: string): string {
  const relativePath = path.relative(repositoryRoot, fileName);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return fileName;
  }
  return relativePath;
}

/** Display width in columns, per character (by code point, so an emoji counts once). */
export function getTextWidth(text: string): { width: number; widths: number[] } {
  let width = 0;
  const widths: number[] = [];
  for (const char of Array.from(text)) {
    const w = getCharacterWidth(char);
    widths.push(w);
    width += w;
  }
  return { width, widths };
}

export function getCharacterWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  // East Asian wide characters (Chinese, Japanese, Korean, full-width forms)
  if ((code >= 0x3000 && code <= 0x9FFF) || (code >= 0xAC00 && code <= 0xD7AF)
    || (code >= 0xF900 && code <= 0xFAFF) || (code >= 0xFF00 && code <= 0xFFEF)) {
    return 2;
  }
  // emoji and pictographs
  if (code >= 0x1F300 && code <= 0x1FAFF) {
    return 2;
  }
  // combining marks
  if (code >= 0x0300 && code <= 0x036F) {
    return 0;
  }
  return 1;
}

/** The longest start of text (characters as getTextWidth counts them) that fits in maxWidth columns. */
export function truncateText(text: string, maxWidth: number, widths: number[]): string {
  const chars = Array.from(text);
  let truncated = '';
  let currentWidth = 0;
  for (let i = 0; i < widths.length && i < chars.length; i++) {
    if (currentWidth + widths[i] > maxWidth) {
      break;
    }
    truncated += chars[i];
    currentWidth += widths[i];
  }
  return truncated;
}

/** A colour per commit; older commits are paler. */
export function getCommitColor(commit: string, timestamp: number): { lightColor: string; darkColor: string } {
  let hash = 0;
  for (let i = 0; i < commit.length; i++) {
    hash = commit.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = (hash * 137.508) % 360;

  const minSaturation = 35;
  const maxSaturation = 90;
  const daysAgo = Math.max(Math.floor((Date.now() / 1000 - timestamp) / (24 * 60 * 60)), 0);
  const decay = Math.exp(-daysAgo / 20);
  const saturation = Math.round(minSaturation + (maxSaturation - minSaturation) * decay);
  const color = `hsl(${h}, ${saturation}%, 50%)`;
  return { lightColor: color, darkColor: color };
}

export function buildUncommitBlame(line: number): Blame {
  return {
    line,
    sourceLine: line,
    commit: UNCOMMITTED,
    author: '',
    mail: '',
    timestamp: 0,
    summary: '',
    commited: false,
    title: '',
  };
}

/** The 0-based lines an edit added, deleted and modified, so the annotations can follow it until the next save. */
export function resolveChange(change: TextDocumentContentChangeEvent) {
  const addedLines: number[] = [];
  const deletedLines: number[] = [];
  const modifiedLines: number[] = [];
  const changeText = change.text;
  const startLine = change.range.start.line;
  const endLine = change.range.end.line;
  const startLineCharacter = change.range.start.character;

  if (changeText.length === 0) {
    // characters deleted
    const diffLine = endLine - startLine;
    if (diffLine === 1) {
      deletedLines.push(startLine + 1);
    } else if (diffLine > 1) {
      const start = startLineCharacter > 0 ? startLine + 1 : startLine;
      const end = start + diffLine - 1;
      for (let i = start; i <= end; i++) {
        deletedLines.push(i);
      }
    } else if (diffLine === 0) {
      modifiedLines.push(startLine);
    }
  } else {
    const trimmedChangeText = changeText.replace(/ +$/, '');
    if (trimmedChangeText === '\n' || trimmedChangeText === '\r\n') {
      // a new line
      addedLines.push(startLineCharacter > 0 ? startLine + 1 : startLine);
    } else {
      // characters added or replaced
      const crossLines = endLine - startLine + 1;
      const textLines = changeText.split(/\r?\n/).length;
      const diff = textLines - crossLines;
      if (diff > 0) {
        for (let i = startLine; i <= endLine; i++) {
          modifiedLines.push(i);
        }
        for (let i = endLine + 1; i <= endLine + diff; i++) {
          addedLines.push(i);
        }
      } else if (diff < 0) {
        for (let i = startLine; i <= endLine + diff; i++) {
          modifiedLines.push(i);
        }
        for (let i = endLine + diff + 1; i <= endLine; i++) {
          deletedLines.push(i);
        }
      } else {
        for (let i = startLine; i <= endLine; i++) {
          modifiedLines.push(i);
        }
      }
    }
  }

  return { addedLines, deletedLines, modifiedLines };
}
