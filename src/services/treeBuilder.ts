import { TreeItemCollapsibleState, Uri } from 'vscode';
import { COMPARE_FILES } from '../constants/commands';
import { File } from '../models/file';
import * as path from 'path';
import { uiContext } from '../context/ui';
import type { DiffPaths, DiffPathss, ViewOnlyPaths } from '../types';
import { log } from './logger';
import { hasParsableContent } from './fileParser';

export type TreeNode = {
  path: string;
  relativePath: string;
  [key: string]: TreeNode | [[string, string], string] | string;
};

// Folders keep their children in a Map, apart from their own fields, so no file or folder name can clash with
// them: names like "path", "constructor", "toString" or "__proto__" used to lose files or crash the tree
// (the old lodash set/get skipped or followed those keys).
type FolderNode = { kind: 'folder'; path: string; relativePath: string; children: Map<string, FolderNode | FileNode> };
type FileNode = { kind: 'file'; paths: DiffPaths; relativePath: string };

export function build(paths: DiffPathss | ViewOnlyPaths, basePath: string) {
  if (uiContext.diffViewMode === 'list') {
    return {
      tree: {},
      treeItems: createList(paths, basePath),
    }
  }

  const root: FolderNode = { kind: 'folder', path: basePath, relativePath: '', children: new Map() };
  try {
    paths.forEach((filePath) => {
      const relativePath = path.relative(basePath, filePath[0]);
      const segments = relativePath.split(path.sep);
      const fileName = segments.pop()!;
      const walked: string[] = [];
      let folder = root;
      for (const segment of segments) {
        walked.push(segment);
        let next = folder.children.get(segment);
        if (next?.kind !== 'folder') {
          next = {
            kind: 'folder',
            path: path.join(basePath, ...walked),
            relativePath: path.join(...walked),
            children: new Map(),
          };
          folder.children.set(segment, next);
        }
        folder = next;
      }
      folder.children.set(fileName, { kind: 'file', paths: filePath as DiffPaths, relativePath });
    });
  } catch (error) {
    log(`can't build the tree: ${error}`);
  }
  return { tree: toPlainTree(root), treeItems: createHierarchy(root) };
}

function createList(paths: DiffPathss | ViewOnlyPaths, basePath: string): File[] {
  try {
    return paths.map(([path1, path2]) => {
      const relativePath = path.relative(basePath, path1);
      const fileName = path.basename(path1);
      return new File({
        label: fileName,
        type: hasParsableContent(path1, path2) ? 'file-parsable' : 'file',
        collapsibleState: TreeItemCollapsibleState.None,
        command: {
          title: path1,
          command: COMPARE_FILES,
          arguments: [[path1, path2 || ''], relativePath],
        },
        resourceUri: Uri.file(path1),
        description: true,
        relativePath,
      });
    });
  } catch (error) {
    log(`can't create list`, error);
    return [];
  }
}

function createHierarchy(folder: FolderNode): File[] {
  return [...folder.children].map(([name, node]) => {
    if (node.kind === 'folder') {
      return new File({
        label: name,
        type: 'folder',
        collapsibleState: TreeItemCollapsibleState.Collapsed,
        children: createHierarchy(node),
        resourceUri: Uri.file(node.path),
        relativePath: node.relativePath,
      });
    }
    return new File({
      label: name,
      type: hasParsableContent(node.paths[0], node.paths[1]) ? 'file-parsable' : 'file',
      collapsibleState: TreeItemCollapsibleState.None,
      command: {
        title: name,
        command: COMPARE_FILES,
        arguments: [node.paths, node.relativePath],
      },
      resourceUri: Uri.file(node.paths[0]),
      relativePath: node.relativePath,
    });
  });
}

// The tree as a plain object, in the shape build() always returned (used by tests and for debugging).
function toPlainTree(folder: FolderNode): TreeNode {
  const plain = {} as TreeNode;
  if (folder.relativePath) {
    plain.path = folder.path;
    plain.relativePath = folder.relativePath;
  }
  for (const [name, node] of folder.children) {
    const value = node.kind === 'folder' ? toPlainTree(node) : [node.paths, node.relativePath];
    // defineProperty: plain assignment to "__proto__" would change the prototype instead of adding a key.
    Object.defineProperty(plain, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return plain;
}
