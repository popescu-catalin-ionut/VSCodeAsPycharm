// Script and .env paths of saved configurations, as launch.json stores them.
//
// PyCharm-style Run takes a relative script ("scripts/main.py") relative to the project folder. VS Code's own
// launcher (F5, the Run and Debug view, VS Code's Restart) hands it to the Python debugger as is, which takes it
// relative to the working directory: with "cwd": "${workspaceFolder}/scripts" that is scripts/scripts/main.py, and
// the run fails with "file not found". Saved with "${workspaceFolder}/" in front, both read it the same way.
import * as path from 'path';
import { DebugConfiguration, debug, Disposable } from 'vscode';

const WORKSPACE_PREFIX = /^\$\{workspaceFolder\}[\\/]/;

/** "scripts/main.py" -> "${workspaceFolder}/scripts/main.py"; absolute paths and other variables stay as they are. */
export function pinToWorkspace(p: string): string {
  if (!p || !p.trim() || p.includes('${') || path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) {
    return p;
  }
  return '${workspaceFolder}/' + p.replace(/^\.[\\/]/, '');
}

/** The inverse, for showing the path in the editor as the user typed it. */
export function unpinFromWorkspace(p: string): string {
  return p.replace(WORKSPACE_PREFIX, '');
}

/** At launch by VS Code itself: entries saved before this fix get their relative paths pinned too. */
export function pinManagedPaths(config: DebugConfiguration): DebugConfiguration {
  if (config.charmrunManaged !== true) {
    return config;
  }
  const pinned = { ...config };
  for (const key of ['program', 'envFile']) {
    if (typeof pinned[key] === 'string') {
      pinned[key] = pinToWorkspace(pinned[key]);
    }
  }
  return pinned;
}

export function registerLaunchPathFix(): Disposable {
  const provider = { resolveDebugConfiguration: (_folder: unknown, config: DebugConfiguration) => pinManagedPaths(config) };
  return Disposable.from(...['debugpy', 'python'].map((type) => debug.registerDebugConfigurationProvider(type, provider)));
}
