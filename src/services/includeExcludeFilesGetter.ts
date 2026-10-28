import { l10n } from 'vscode';
import type { IncludeExcludePathsResult } from '../types';
import { showErrorMessage } from '../utils/ui';
import { getConfiguration } from './configuration';
import { log } from './logger';

function getFilesFilterByType(type: keyof IncludeExcludePathsResult): string[] {
  const filesFilter = getConfiguration(type);
  return (filesFilter ?? []).flatMap(expandBraces);
};

// dir-compare takes one comma-separated string, so "*.{js,ts}" would be cut at its comma.
// Expanding the braces first ("*.js", "*.ts") keeps the meaning.
export function expandBraces(pattern: string): string[] {
  const group = /\{([^{}]*,[^{}]*)\}/.exec(pattern); // innermost {a,b}
  if (!group) {
    return [pattern];
  }
  const before = pattern.slice(0, group.index);
  const after = pattern.slice(group.index + group[0].length);
  return [...new Set(group[1].split(',').flatMap(alt => expandBraces(before + alt + after)))];
}

export function getIncludeAndExcludePaths(): IncludeExcludePathsResult {
  try {
    const excludeFiles = getFilesFilterByType('excludeFilter');
    const includeFiles = getFilesFilterByType('includeFilter');

    return {
      excludeFilter: excludeFiles.join(','),
      includeFilter: includeFiles.join(','),
    };
  } catch (error) {
    showErrorMessage(l10n.t('Error while parsing include/exclude files'), error);
    log(error);
    return {
      excludeFilter: '',
      includeFilter: '',
    };
  }
};
