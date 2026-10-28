# AsPycharm

One VS Code extension, our own build, from our Forgejo: `http://192.168.3.241:3000/catalinpop/VSCodeAsPycharm`.
It merges two extensions, reviewed line by line on 2026-10-27:

| Part | From | What it adds |
|---|---|---|
| **Compare Folders** | [moshfeu/vscode-compare-folders](https://github.com/moshfeu/vscode-compare-folders) v0.30.0 (MIT), full git history kept, remote `upstream` | the Compare Folders panel: diff two folders, open file diffs, copy / take / delete files |
| **Refresh Explorer** | [LLLLinda/vscode-extension-refresh](https://github.com/LLLLinda/vscode-extension-refresh) | "Refresh Explorer" in the Explorer's right-click menu (one menu entry in `package.json`, no code) |

Our changes on top of upstream: the extension ID is `catalinpop.aspycharm` (so the Marketplace never auto-updates it
over our build), the Refresh Explorer menu entry, and a fix: deleting a file now asks according to
`compareFolders.warnBeforeDelete` (upstream asked according to `warnBeforeTake`).

## Install on a machine (no Node needed)

The built extension is committed in `dist\`. On any Windows machine with VS Code and access to Forgejo:

```powershell
git clone git@git-local:catalinpop/VSCodeAsPycharm.git D:\VSCodeAsPycharm   # or ssh://git@192.168.3.241:2223/catalinpop/VSCodeAsPycharm.git
D:\VSCodeAsPycharm\install.cmd
```

- `install.cmd` (or `install.ps1`) uninstalls the two extensions it replaces if present
  (`moshfeu.compare-folders`, `linda-cheung.content-menu-item-refresh`), installs `dist\aspycharm-*.vsix`, and checks
  that VS Code lists it. Then reload the VS Code windows.
- **Update:** `D:\VSCodeAsPycharm\install.cmd -Pull` (git pull, then reinstall).
- **No Forgejo access** (e.g. the laptop away from home): copy `dist\aspycharm-*.vsix` over and run
  `install.ps1 -Vsix <path>`, or VS Code > Extensions > `...` > Install from VSIX.

## Build after a change

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test
```

`build.ps1` downloads a portable Node 20 into `.tools\` once (SHA-256 checked against nodejs.org; nothing installed
system-wide), installs dependencies from `yarn.lock` with install scripts disabled, compiles, runs the tests with
`-Test` (they run inside a test copy of VS Code, downloaded into `.vscode-test\`), and writes `dist\aspycharm-<version>.vsix`.
Bump `version` in `package.json`, build, commit the new VSIX, push; then `install.cmd -Pull` on each machine.

**Taking upstream fixes:** `git fetch upstream; git merge upstream/master`, review the diff, build with `-Test`.

---

# Compare Folders (upstream documentation)


The extension allows you to compare folders, show the diffs in a list and present diff in a splitted view side by side.

![Screen record](https://user-images.githubusercontent.com/3723951/92312411-f1f3b600-efc8-11ea-93b8-e90a3e25e9cb.gif)

## Thanks

The extension uses the great [`dir-compare`](https://github.com/gliviu/dir-compare) package made by [Liviu Grigorescu](https://github.com/gliviu). If you like this extension, please give a star to `dir-compare`!

## Limitations

Currently seems like there might be issues [[#81](https://github.com/moshfeu/vscode-compare-folders/issues/81), [#83](https://github.com/moshfeu/vscode-compare-folders/issues/83)] with comparing local and remote folders over ssh.
Please take this under consideration.

## How to use?

There are several ways to choose folders to compare:

- Command Palette
  - `Compare a folder against workspace` choose a folder to compare against the workspace's folder (when workspace is not empty)
  - `Choose 2 folders and compare` - opens OS folder chooser twice
- Compare Folders Panel (Click on the icon in the Activity Bar)
  - `Click to select a folder` see 1st item
  - `Click to select folders` see 2nd item
- File explorer
  - Select 2 folders, right click and click on `Compare selected folders` see 2nd item
- From history
  - `Pick from recent compares` chose one of the pairs you compared in the past.
  - (The list can be reset by `Clear recent compares`)

## UI Features per Panel Section:

### Differences
- Toolbar
  - `Pick from History`: Choose one of the pairs you compared in the past.
  - `Swap Sides`: Swap the sides of the compared folders.
  - `Refresh`: Re-compare the folders if there are changes in the compared folders' files.
  - `View as List / View as Tree`: Toggle between list and tree view modes.
- Files
  - `Dismiss`: Remove the file from the list of compared items.
  - `Take My File / Take Compared File`: Replace the file with the one from the other side.
  - `Exclude from Comparison`: Add the file or folder to the `excludeFilter` setting to permanently exclude it from comparisons.

### Only in My Folder / Only in Compared Folder
- Files
  - `Copy to My Folder / Copy to Compared Folder`: Copy the file to the other side.
  - `Delete`: Permanently delete the file from the file system.
  - `Exclude from Comparison`: Add the file or folder to the `excludeFilter` setting to permanently exclude it from comparisons.


## Options (under vscode settings)

- `excludeFilter` - glob string
- `includeFilter` - glob string

***Example***

```json
"compareFolders.excludeFilter": [
  "**/node_modules",
  "**/.svn",
  "**/.git"
]
```
- `compareContent` - boolean - Compares files by content
- `diffViewTitle` - One of the options: "name only", "compared path", "full path"
- `ignoreFileNameCase` - boolean - Compare files with the same name but different case
- `diffLayout` - One of the options: "local <> compared" or "compared <> local"
- `showIdentical` - boolean - Whether or not show the identical files panel
- `showFileCount` - boolean - Show the number of files in each view section title
- `useDiffMerge` - boolean - Whether or not using [`Diff & Merge`](https://marketplace.visualstudio.com/items?itemName=moshfeu.diff-merge) extension as the Diff viewer. In order to use this option, you should install the extension
- `folderLeft` + `folderRight` - strings - paths of 2 folders, compare them on the extension load.
- `fileParsingRules` - Array of rules for parsing specific file patterns with external tools when viewing diffs. Files are parsed on-demand only when you select "View Parsed Diff" button, which will show up next to files which match a parsing rule.

***Example***
```json
"compareFolders.fileParsingRules": [
  {
    "pattern": "*.json",
    "command": "jq",
    "env": {
      "SOME_ENV_VAR": "SOME_ENV_VALUE"
    },
    "args": ["--sort-keys", ".", "{file}"]
  }
]
```
- `ignoreExtension` - Set groups of extensions so while comparing, pairs of files considered the same file if both of the files extension are in the same group. **Note:** each extension can show **only once** it this list
***Example***
```json
"compareFolders.ignoreExtension": [
  ["php", "cs"]
]
```
- `ignoreLineEnding` - boolean - ignore crlf/lf line ending differences
- `ignoreWhiteSpaces` - boolean - ignore white spaces at the beginning and ending of a line (similar to `diff -b`)
- `ignoreAllWhiteSpaces` - boolean - ignore all white space differences (similar to `diff -w`)
- `ignoreEmptyLines` - boolean - ignore differences caused by empty lines (similar to `diff -B`)
- `ignoreStrings` - string[] - list of strings to ignore when comparing file contents. Files that differ only by these strings are treated as identical. Example: `["dev", "staging", "prod"]` to compare configuration files across environments. Only applies when `compareContent` is enabled. Binary files are always compared normally. ⚠️ This option reads and transforms every compared text file in memory and may be slow on large files.
- `respectGitIgnore` - boolean - include / exclude files based on .gitignore - this option works together with `includeFilter` and `excludeFilter` options. ⚠️ The extension supports the main basic gitignore rules. For instance, it supports negation (`!`), but it doesn't support .gitignore files in subfolders. If there is an important use case that is not supported, please open an issue.
- `warnBeforeDelete` - boolean - Show a warning message before deleting files
- `warnBeforeTake` - boolean - Show a warning message before taking/replacing files
- `defaultDiffViewMode` - One of the options: "tree" or "list". The default view mode when vscode is opened. Later it can be toggled by the "View as list / View as tree" button

## CLI

By calling the following command from the terminal / command line, the extension will be calling on vscode load and show the differences view

```shell
COMPARE_FOLDERS=DIFF code path/to/folder1 path/to/folder2
```

## Contributors

<table>
  <tr>
    <td>
      <a href="https://github.com/llgcode" target="_blank">
        <img width="40" height="40" src="https://avatars3.githubusercontent.com/u/524083?s=88&v=4" alt="llgcode">
        <div>
          llgcode
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/md2perpe" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/543239?v=4" alt="md2perpe">
        <div>
          Per Persson
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/orellabac" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/4247006?v=4" alt="orellabac">
        <div>
          orellabac
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/niccolomineo" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/5409469?v=4" alt="Niccolò Mineo">
        <div>
          Niccolò Mineo
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/sampellino" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/5458241?v=4" alt="Sam Pellino">
        <div>
          Sam Pellino
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/michaelmesser" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/16529951?v=4" alt="Michael Messer">
        <div>
          Michael Messer
        </div>
      </a>
    </td>
    <td>
      <a href="https://github.com/koby08" target="_blank">
        <img width="40" height="40" src="https://avatars.githubusercontent.com/u/33871889?v=4" alt="koby08">
        <div>
          koby08
        </div>
      </a>
    </td>
  </tr>
</table>

## Localization

Compare Folders is available in the following languages:

- **English** - Default
- **한국어 (Korean)** - Thanks to [@justcontributor](https://github.com/justcontributor)

Want to help translate this extension into your language? See the [Localization Guide](LOCALIZATION.md) for instructions.

## Like the extension?

Show your love

- [⭐️](https://github.com/moshfeu/vscode-compare-folders)
- [Give it 5 ⭐️](https://marketplace.visualstudio.com/items?itemName=moshfeu.compare-folders&ssr=false#review-details)

## Isn't working as expected?

Please create [an issue](https://github.com/moshfeu/vscode-compare-folders/issues/new)

## Changelog

You can find it [here](/CHANGELOG.md)

## Credits
Activity bar's icon (and more) by [Stockio.com](https://www.stockio.com/free-icon/folders)
Null icon made from <a href="http://www.onlinewebfonts.com/icon">Icon Fonts</a> is licensed by CC BY 3.0
External link icon made by <a href="https://www.flaticon.com/authors/dave-gandy" title="Dave Gandy">Dave Gandy</a> from <a href="https://www.flaticon.com/" title="Flaticon">www.flaticon.com</a>

## Read more about the development process

You can find the series of the posts about how this extension developed step by step in [medium.com](https://medium.com/@moshfeu/comparefolders-visual-studio-code-extension-journey-intro-b540a0539629?source=friends_link&sk=db37e1889766ccd8fe553958a12a8f69).
