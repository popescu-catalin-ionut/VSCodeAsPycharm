# AsPycharm — working rules

Our VS Code extension: upstream Compare Folders (moshfeu/vscode-compare-folders, MIT, remote `upstream`) + the
Explorer "Refresh Explorer" menu entry (from LLLLinda/vscode-extension-refresh) + PyCharm-like Python snippets and
Alt+P print (ported from un4gt/pycharm-like-snippets, MIT: `snippets/`, `src/services/printExpression.ts`) + Python run
configurations (ported from yingbo/charmrun 1.6.1, MIT: `src/charmrun/`, `resources/charmrun/`) + Ctrl+Click links in
docstrings and comments (JetBrains plugin rufatpro/plugins py-doc-links, MIT, rewritten in TypeScript: `src/pyDocLinks/`,
`resources/pyDocLinks/`) + our PyCharm-style Debug panel (`src/debugPanel/`), as one extension
`catalinpop.aspycharm`. Repository: Forgejo `catalinpop/VSCodeAsPycharm`
(`git@git-local:catalinpop/VSCodeAsPycharm.git`), branch `main`, checkout `D:\VSCodeAsPycharm`. Install and build steps
are in [README.md](README.md). Upstream's own agent notes are in [AGENTS.md](AGENTS.md).

- **Install:** `install.cmd` (`install.ps1`) installs the committed `dist\vscodeaspycharm-*.vsix`; it needs no Node.
- **Build:** `build.ps1 -Test` (portable Node in `.tools\`, `yarn.lock` only, install scripts off, tests in a test copy
  of VS Code). After a change: bump `version` in `package.json`, build with `-Test`, commit the new VSIX in `dist\`.
- **Every bug gets a test** in `src/test/suite/` that fails on the old code.
- **Upstream merges:** `git fetch upstream; git merge upstream/master`, then review the diff for anything that runs
  commands, uses the network or touches files before building. New dependencies are checked on the npm registry.
- **Commits:** commit and push only on the user's go. Never `git push --force`.
