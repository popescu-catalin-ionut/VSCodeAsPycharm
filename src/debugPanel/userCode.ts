// "My code" for Step Into My Code: what PyCharm treats as project code rather than libraries.
import * as path from 'path';

// Folders holding installed packages or Python itself, inside or outside the project.
const LIBRARY_DIR = /[\\/](site-packages|dist-packages|\.?venv|virtualenvs?|__pypackages__|\.tox|\.nox|node_modules)[\\/]/i;
// The standard library: .../lib/python3.12/... (Linux, macOS) or ...\Lib\... (Windows installs).
const STDLIB_DIR = /[\\/]lib[\\/]python\d+(\.\d+)?[\\/]|^[a-z]:\\[^\\]*python[^\\]*\\lib\\/i;

/**
 * Whether `file` is your code: a real file, not in a library folder, and inside one of the workspace folders
 * (any file when no folder is open).
 */
export function isUserCode(file: string | undefined, workspaceRoots: string[]): boolean {
  if (!file || !path.isAbsolute(file) || LIBRARY_DIR.test(file) || STDLIB_DIR.test(file)) {
    return false;
  }
  if (workspaceRoots.length === 0) {
    return true;
  }
  const norm = (p: string) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
  const f = norm(file);
  return workspaceRoots.some((root) => {
    const r = norm(root).replace(/[\\/]+$/, '');
    return f === r || f.startsWith(r + path.sep);
  });
}
