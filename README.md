# AsPycharm

One VS Code extension, our own build, from our Forgejo: `http://192.168.3.241:3000/catalinpop/VSCodeAsPycharm`.
It merges five extensions and plugins, each reviewed line by line (the first two on 2026-10-27, the others on
2026-10-28):

| Part | From | What it adds |
|---|---|---|
| **Compare Folders** | [moshfeu/vscode-compare-folders](https://github.com/moshfeu/vscode-compare-folders) v0.30.0 (MIT), full git history kept, remote `upstream` | the Compare Folders panel: diff two folders, open file diffs, copy / take / delete files |
| **Refresh Explorer** | [LLLLinda/vscode-extension-refresh](https://github.com/LLLLinda/vscode-extension-refresh) | "Refresh Explorer" in the Explorer's right-click menu (one menu entry in `package.json`, no code) |
| **PyCharm-like snippets** | [un4gt/pycharm-like-snippets](https://github.com/un4gt/pycharm-like-snippets) v0.1.0 (MIT, licence in `snippets/`), ported at commit `505c2d1` | 32 PyCharm-style Python snippets and **Alt+P** to wrap a line in `print(...)` |
| **PyCharm-style Run** (from CharmRun) | [yingbo/charmrun](https://github.com/yingbo/charmrun) v1.6.1 (MIT, licence in `resources/charmrun/`), ported at commit `2327ba4` into `src/charmrun/` | PyCharm-style Python run configurations: a sidebar, a form editor, Run / Debug buttons, before-launch steps |
| **Python Doc Links** | [rufatpro/plugins `jetbrains/py-doc-links`](https://github.com/rufatpro/plugins/tree/main/jetbrains/py-doc-links) 0.2.10 (MIT, licence in `resources/pyDocLinks/`), a JetBrains plugin rewritten in TypeScript from commit `bae1de9` into `src/pyDocLinks/` | **Ctrl+Click** on `file.py` and Sphinx references (`:py:func:`, `:class:`, ...) in docstrings and comments |
| **PyCharm-style Debug panel** | our own, in `src/debugPanel/` | PyCharm's Debug tool window: session tabs, Threads & Variables, Console, the debug toolbar |

Our changes on top of upstream: the extension ID is `catalinpop.aspycharm` (so the Marketplace never auto-updates it
over our build), the Refresh Explorer menu entry, and these fixes (each with a test that fails on upstream's code):

- Deleting a file asks according to `compareFolders.warnBeforeDelete` (upstream asked according to `warnBeforeTake`).
- **Dismiss** works on Windows (upstream compared `/c:/x/a.txt` with `C:\x\a.txt`, so nothing was hidden).
- `excludeFilter` / `includeFilter` accept brace patterns like `**/*.{log,tmp}` (upstream cut them at the comma).
- The tree view shows files in folders named `constructor`, `toString`, `__proto__`, `path`, ... (they went missing
  or the view crashed).
- `ignoreExtension` pairs `a.php.php` with `a.php.cs` (upstream replaced the first `.php`, not the last).
- `fileParsingRules`: every `{file}` in an argument is replaced, and paths containing `$&` or `$$` are passed as is.
- The error **Report** button opens a new issue on our Forgejo (upstream sent it, with system details, to its GitHub).

### PyCharm-like Python snippets

Type the prefix in a Python file and pick it from the suggestions:

| Prefix | Inserts | Prefix | Inserts |
|---|---|---|---|
| `main` | `if __name__ == "__main__":` | `forr` | `for x in range(...)` |
| `compl` / `compli` | list comprehension (with `if`) | `afor` | `async for ... in ...` |
| `compd` / `compdi` | dict comprehension (with `if`) | `openw` | `with open(...) as f:` |
| `comps` / `compsi` | set comprehension (with `if`) | `trye` / `tryf` / `tryl` | try / except (+ finally / else) |
| `compg` / `compgi` | generator expression (with `if`) | `whl` | `while ...:` |
| `iter` or `fori` | `for x in ...:` | `wth` / `witha` / `awith` | `with` / `with ... as` / `async with` |
| `itere` or `fore` | `for i, x in enumerate(...):` | `im` / `ims` | `import m` / `import m as a` |
| `prop` / `props` / `propsd` | property getter (+ setter / deleter) | `fim` / `fims` | `from m import x` (`as a`) |
| `deff` / `adef` | `def` / `async def` | `klass` / `klassi` | class (with a base class) |

**Alt+P** (or *AsPycharm: Wrap Line in print()* in the Command Palette) turns `    fib(n)` into `    print(fib(n))`,
wherever the cursor is on the line; with several cursors, each line is wrapped once. A trailing `# comment` stays
after the `print(...)`, and a line that is only a comment is left alone.

Fixed while porting, each with a test in `src/test/suite/pycharmSnippets.test.ts`: `fori` / `fore` were documented but
missing; `awith` produced `async with x` without the `:`; `deff` / `adef` produced `def f( args)`; Alt+P failed unless
the cursor was at the very end of the line, mangled lines with trailing spaces, and wrapped only the first cursor's line.
Not taken: their build setup and `package-lock.json` (which pulls from the `registry.npmmirror.com` mirror); nothing
new is needed to build it.

### PyCharm-style Run: Python run configurations

Ported from [CharmRun](https://github.com/yingbo/charmrun) and shown as one feature, **PyCharm-style Run**. Its command IDs
(`charmrun.*`) and `launch.json` keys (`charmrunManaged`, `charmrunId`, ...) keep the original prefix, so existing
configurations and custom keyboard shortcuts keep working.

Open **PyCharm-style Run** in the Activity Bar (the ▶ icon), click **Add Configuration**, fill the form (script or module,
interpreter, arguments, working directory, environment variables or an `.env` file), then **Save & Close** or
**Apply**. Pick the active configuration in the status bar and run it with the ▶ / 🐞 buttons there, the inline
buttons in the sidebar, or the Command Palette (*PyCharm-style Run: Run Configuration*, *Debug Configuration*,
*Run Current Python File*, ...). Double-click a configuration to edit it.

- Configurations are stored in `.vscode/launch.json` as ordinary `debugpy` entries (marked `"charmrunManaged": true`),
  so VS Code's own Run and Debug view can launch them too. Existing Python entries can be **adopted**; entries
  PyCharm-style Run did not create or adopt are never touched. Format: [resources/charmrun/CONFIG_FORMAT.md](resources/charmrun/CONFIG_FORMAT.md).
- **Before launch** steps run first, in order: another configuration, an external tool (a command run through the
  shell), or a VS Code task. A failing step stops the launch. Log: *Output > PyCharm-style Run: Before Launch*.
- **Save console output to a file**, overwritten on every run.
- Interpreter: the one selected in the Python extension, else `python.defaultInterpreterPath`, else `python3` /
  `python` on PATH; it must answer `--version` with a Python version. Needs the **Python Debugger** extension
  (`ms-python.debugpy`).
- Failures (missing interpreter or script, non-zero exit code) are shown as notifications; log: *Output > PyCharm-style Run*.

**Right-click a Python file, as in PyCharm** (in the Explorer or in the editor):

| Menu entry | PyCharm | Keys (Windows / Linux, macOS) |
|---|---|---|
| **Run Python File (PyCharm-style)** | Run 'main' | Ctrl+Shift+F10, ⌃⇧R |
| **Debug Python File (PyCharm-style)** | Debug 'main' | Ctrl+Shift+F9, ⌃⇧D |
| **Modify Run Configuration...** | Modify Run Configuration... | |

- If a PyCharm-style Run configuration already runs that file, it is used (with its interpreter, arguments, environment and
  before-launch steps) and becomes the active one in the status bar.
- Otherwise, like PyCharm, a temporary configuration named after the file (`main` for `main.py`) runs it, with the
  file's folder as working directory and the workspace's `.env` if there is one. It is not written to `launch.json`;
  **Modify Run Configuration...** opens it in the editor as a *New Run Configuration*, and saving it there keeps it.
- VS Code's menus cannot show the file name in an entry, so they read *Run Python File* rather than *Run 'main'*.
  The keys work with the cursor in a Python file. Ctrl+Shift+F9 is also the Chat view's *previous file tree*, which
  only applies inside Chat; on macOS, ⌃⇧R in a Python file runs it instead of opening *Refactor...*.
- Works for `.py` and `.pyw` files (any letter case), and in the editor for any file open as Python (e.g. a script
  without an extension that starts with `#!/usr/bin/env python`).
- The file must be in an open folder (File > Open Folder), since configurations live in its `.vscode/launch.json`.

Like VS Code's own `tasks.json`, a `launch.json` from someone else's repository can contain commands (an interpreter
path, external-tool steps). They run only when you press Run or Debug, and VS Code keeps the whole extension off in
Restricted Mode, so trust a folder before running its configurations.

Fixed while porting, each with a test in `src/test/suite/charmrun.test.ts` that fails on CharmRun 1.6.1:

- A `launch.json` with a trailing comma (which VS Code accepts) could not be read, and the next save **overwrote the
  whole file**, deleting every other launch configuration. Now trailing commas are read, and a file with a real
  syntax error is never written.
- Every save rewrote `launch.json` and **deleted its comments**. Now only PyCharm-style Run's own entries are edited, in place.
- Arguments with spaces were **split on save** (`--name "John Smith"` became three arguments) just by opening the
  configuration and pressing Apply. The form now quotes them, so they come back unchanged.
- External-tool steps failed for a command in a folder with a space (`C:\Program Files\...`), and an argument with
  `&` was cut there by `cmd.exe`. Both are now quoted.
- An entry copied by hand in `launch.json` (same `charmrunId`) made edits to it vanish on save; each copy is now
  kept and edited separately.
- Saving a configuration that was deleted meanwhile (another window, a hand edit) silently threw the edits away;
  it is now added back.
- A `launch.json` with a syntax error showed the same warning 2–3 times on every save; now once per breakage.
- *Duplicate Configuration* from the Command Palette did nothing; it now asks which configuration, like Edit and
  Delete.

Not taken: their build setup (esbuild, eslint), screenshot script, publishing workflows, and their `CLAUDE.md` /
`AGENTS.md` (which tell coding agents to hide their involvement). New dependency: `jsonc-parser` 3.3.1 (Microsoft,
MIT, no dependencies, no install scripts), the parser VS Code itself uses for `launch.json`.

### Python Doc Links: Ctrl+Click in docstrings and comments

In a Python file, **Ctrl+Click** (or F12, *Go to Definition*) on a reference inside a docstring, any other string, or
a `#` comment. References in code are left to the Python extension.

```python
def example():
    """
    File: submodule.py                     (also a path: pkg/a/main.py, ../tools/x.py)
    Function: :py:func:`submodule.process_submodule_data`
    Filename form: :py:func:`submodule.py.process_submodule_data`
    Current module: :func:`run_main_flow`
    Variable: :py:data:`config.hosters_data`
    Class: :py:class:`ObjectWithProperties`
    Method: :meth:`shapes.Circle.area`     (or :meth:`Circle.area` in the current file)
    Module: :py:mod:`submodule`, :mod:`pkg.util`, :py:mod:`submodule.py`
    Sphinx forms: :func:`~pkg.util.helper`, :func:`the helper <pkg.util.helper>`, :func:`helper()`
    """
    # see submodule.py
```

| Reference | Goes to |
|---|---|
| `file.py`, `pkg/file.py` | the file: next to the current file first, else in the workspace |
| `:py:func:` / `:func:` | `def` (falls back to `class`, then a variable) |
| `:py:meth:` / `:meth:` | `def` inside the class (`module.Class.method` or `Class.method`) |
| `:py:class:` / `:class:` / `:exc:` | `class` |
| `:py:data:` / `:data:` | module-level variable |
| `:py:attr:` / `:attr:` | class attribute, or `self.name = ...` in the class |
| `:py:mod:` / `:mod:` | `module.py`, or the package's `__init__.py` |
| `:obj:` | any of the above |

A one-part name (<code>:func:`run`</code>) is looked up in the current file. `pkg.module.func` is looked up as `func` in
`pkg/module.py`; when several files share a name (many `main.py`), the one in the named folders, then the one next to
the current file, wins, and copies under `docs/`, `examples/` or `!to_tg/` come last. If the module is found but not
the name, the module opens at the top. Folders like `.venv`, `node_modules` and `__pycache__` are not searched.

Compared with the JetBrains plugin (each checked against its own patterns and rules, each with a test in
`src/test/suite/pyDocLinks.test.ts`):

- Added Sphinx roles and forms it did not match: `:mod:`, `:meth:`, `:exc:`, `:obj:`, `title <target>`, `~target`,
  `target()`.
- `shapes.Circle.area` is `area` inside class `Circle` in `shapes.py`; the plugin looked for a file `Circle.py`.
- A variable resolves to the module-level assignment, not the first local one inside a function; `LIMIT == 3` is
  no longer taken for an assignment; `def run(` written inside a docstring is not taken for the definition.
- `pkg/a/main.py` keeps its folders; the plugin matched only `main.py`, so any `main.py` could win.

Not taken: the Kotlin/Gradle build (rewritten for VS Code; the Gradle wrapper jar was checked against Gradle's
published checksums and is genuine) and the author's separate VS Code version (`rufat.py-doc-links`, which links
inside code too); `install.cmd` removes that one if installed, so links do not appear twice.

### PyCharm-style Debug panel

A **Debug** tab in the bottom panel (next to Terminal and Debug Console) laid out like PyCharm's Debug tool window.
It works with any debugger; it is made for Python (the **Python Debugger** extension, `ms-python.debugpy`).
Start debugging as usual (F5, the Run and Debug view, or PyCharm-style Run's Debug button); when the program stops, the
panel comes forward.

| Part | What it does |
|---|---|
| Session tabs | One tab per debug session (`car`, `main`, ...): a dot shows running, stopped or ended. An ended session keeps its tab (and console) until you close it with ×; closing a running one stops it. |
| **Threads & Variables** | Left: the thread list (`MainThread`, ...) and the stopped thread's frames (`step, car.py:15`); click a frame to open its line and see its variables. Right: the frame's local variables as a tree, PyCharm-style: `odometer = {int} 5`, `self = {Car} <__main__.Car object at ...>`; other scopes (Globals) below. |
| Evaluate / watches | The box above the tree: **Enter** evaluates in the selected frame and shows `result = ...` at the top; **Ctrl+Shift+Enter** adds a watch (blue, at the top of every stop; × removes it). |
| **Console** | The program's output (when it writes to the Debug Console: PyCharm-style Run's *Internal console* terminal option, or `"console": "internalConsole"`), and a `>>>` prompt that runs Python in the selected frame. |
| Toolbar | Rerun, Stop, Resume (F5), Pause, Step Over (F10), Step Into (F11), Step Out (Shift+F11), View Breakpoints, Mute Breakpoints. Steps act on the thread shown in the panel. |
| Frames from anywhere | **Ctrl+Alt+↑ / Ctrl+Alt+↓** (⌘⌥↑ / ⌘⌥↓ on macOS) move up and down the call stack while stopped, from any editor, as in PyCharm. (While debugging, this replaces VS Code's *Add Cursor Above / Below* on those keys.) |
| Protected Attributes | Python objects show their protected (`_x`), special (`__x__`) and function members in groups, as PyCharm does. Setting `aspycharm.debug.groupAttributes` (default on); a launch configuration with its own `variablePresentation` wins. |

Settings: `aspycharm.debug.showPanelOnBreakpoint` (default on) brings the panel forward on every stop. *AsPycharm:
Show PyCharm-style Debug Panel* opens it from the Command Palette.

VS Code's own debug views (Variables, Watch, Call Stack in the Run and Debug sidebar, the floating toolbar) stay as
they are; extensions cannot restyle them. The panel sits next to them; editor features (the current-line highlight,
inline values, hovering a variable) are VS Code's own. Values from the debugged program are shown as text only.
Tests: `src/test/suite/debugPanel.test.ts`, with a scripted debugger and the panel's page run against a fake page.

## Install on a machine (no Node needed)

The built extension is committed in `dist\`. On any Windows machine with VS Code and access to Forgejo:

```powershell
git clone git@git-local:catalinpop/VSCodeAsPycharm.git D:\VSCodeAsPycharm   # or ssh://git@192.168.3.241:2223/catalinpop/VSCodeAsPycharm.git
D:\VSCodeAsPycharm\install.cmd
```

- `install.cmd` (or `install.ps1`) uninstalls the extensions it replaces if present (`moshfeu.compare-folders`,
  `linda-cheung.content-menu-item-refresh`, `tumuerzunong.pycharm-like-snippets`, `yingbo.charmrun`,
  `rufat.py-doc-links`), installs
  `dist\vscodeaspycharm-*.vsix`, and checks that VS Code lists it. Then reload the VS Code windows.
- **Update:** `D:\VSCodeAsPycharm\install.cmd -Pull` (git pull, then reinstall).
- **No Forgejo access** (e.g. the laptop away from home): install from GitHub, below.

## Install from GitHub (a download link, from anywhere)

Every version is attached to a GitHub Release of
[popescu-catalin-ionut/VSCodeAsPycharm](https://github.com/popescu-catalin-ionut/VSCodeAsPycharm/releases).
It is not in VS Code's Extensions search; you install the file yourself.

**Newest version, always this link:**
<https://github.com/popescu-catalin-ionut/VSCodeAsPycharm/releases/latest/download/vscodeaspycharm.vsix>

**In VS Code (no command line):**

1. Open the link above; the browser downloads `vscodeaspycharm.vsix`.
2. In VS Code: **Extensions** view (Ctrl+Shift+X) > **`...`** (top right of the view) > **Install from VSIX...** >
   pick the downloaded file.
3. **Reload** when VS Code asks (or Ctrl+Shift+P > *Developer: Reload Window*).

**In PowerShell (downloads and installs in one go):**

```powershell
$vsix = "$env:TEMP\vscodeaspycharm.vsix"
Invoke-WebRequest https://github.com/popescu-catalin-ionut/VSCodeAsPycharm/releases/latest/download/vscodeaspycharm.vsix -OutFile $vsix -UseBasicParsing
code --install-extension $vsix --force
```

- **A specific version:** pick it on the [Releases page](https://github.com/popescu-catalin-ionut/VSCodeAsPycharm/releases);
  each release also has the file with its version in the name (`vscodeaspycharm-2.2.1.vsix`).
- **Updating:** the same steps again; the newer version replaces the installed one.
- **First install on a machine** that has the original extensions this one replaces: remove them, or their commands
  clash with ours (the clone's `install.cmd` does this for you):

  ```powershell
  'moshfeu.compare-folders','linda-cheung.content-menu-item-refresh','tumuerzunong.pycharm-like-snippets','yingbo.charmrun','rufat.py-doc-links' |
    ForEach-Object { code --uninstall-extension $_ }
  ```
- `code` is VS Code's command line; if PowerShell does not know it, open a new window after installing VS Code, or use
  the steps "In VS Code" above.

### Publishing a new version to GitHub

After a change is built (`build.ps1 -Test`), committed and pushed, attach the VSIX to a release. The second file,
always named `vscodeaspycharm.vsix`, is what the "newest version" link downloads:

```powershell
$v = (Get-Content package.json -Raw | ConvertFrom-Json).version
Copy-Item "dist\vscodeaspycharm-$v.vsix" "$env:TEMP\vscodeaspycharm.vsix" -Force
gh release create "v$v" "dist\vscodeaspycharm-$v.vsix" "$env:TEMP\vscodeaspycharm.vsix" `
  --repo popescu-catalin-ionut/VSCodeAsPycharm --title "AsPycharm $v" --notes "See README.md."
```

GitHub Actions is turned off for this repository: the Compare Folders workflows that came with upstream would
otherwise try (and fail) to publish to the Marketplace whenever a release is created.

## Build after a change

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Test
```

`build.ps1` downloads a portable Node 20 into `.tools\` once (SHA-256 checked against nodejs.org; nothing installed
system-wide), installs dependencies from `yarn.lock` with install scripts disabled, compiles, runs the tests with
`-Test` (they run inside a test copy of VS Code, downloaded into `.vscode-test\`), and writes `dist\vscodeaspycharm-<version>.vsix`.
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
