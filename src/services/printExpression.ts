import { commands, Disposable, Range, Selection, window } from 'vscode';

// Alt+P in Python files: wraps the current line in print(...), like PyCharm's `.print` postfix template.
// From un4gt/pycharm-like-snippets (MIT); the command ID is kept so existing keybindings still work.
// Fixed: works wherever the cursor is on the line, ignores trailing spaces, handles several cursors, and the
// command finishes only after the edit is applied.
export const PRINT_EXPRESSION = 'pycharm-like-snippets.printExpression';

export function registerPrintExpression(): Disposable {
  return commands.registerCommand(PRINT_EXPRESSION, printExpression);
}

async function printExpression() {
  const editor = window.activeTextEditor;
  if (!editor) {
    return;
  }
  const lines = [...new Set(editor.selections.map(s => s.active.line))].sort((a, b) => a - b);
  const cursors: Selection[] = [];
  const applied = await editor.edit(edit => {
    for (const n of lines) {
      const { text } = editor.document.lineAt(n);
      const hash = commentStart(text);
      const code = (hash < 0 ? text : text.slice(0, hash)).trimEnd();
      const start = text.length - text.trimStart().length;
      const expression = code.slice(start);
      if (!expression && hash >= 0) {
        // Only a comment: nothing to print; the cursor stays where it was.
        const keep = editor.selections.find(s => s.active.line === n)!.active;
        cursors.push(new Selection(keep, keep));
        continue;
      }
      // Without a comment, trailing spaces go too; with one, the spaces and the comment stay after print(...).
      const end = hash < 0 ? text.length : code.length;
      edit.replace(new Range(n, start, n, end), `print(${expression})`);
      // Past the closing parenthesis, or between the parentheses when there was nothing to wrap.
      const column = start + 'print('.length + expression.length + (expression ? 1 : 0);
      cursors.push(new Selection(n, column, n, column));
    }
  });
  if (applied) {
    // Each edit stays on its own line, so these columns hold after the edit.
    editor.selections = cursors;
  }
}

// Where a Python comment starts on the line, or -1. A "#" inside a string ('...', "...", '''...''', """...""",
// with backslash escapes) is not a comment.
export function commentStart(text: string): number {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (text.startsWith(quote, i)) {
        i += quote.length - 1;
        quote = '';
      }
    } else if (ch === '#') {
      return i;
    } else if (ch === '"' || ch === "'") {
      quote = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += quote.length - 1;
    }
  }
  return -1;
}
