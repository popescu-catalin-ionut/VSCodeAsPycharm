// The editor shows an argument list as one line of text and reads it back. Both functions also run inside the
// editor webview (injected with toString()), so they must stay self-contained: no imports, no outer variables.

/** Splits a line of arguments. Quotes ("..." or '...') group, and are removed; quoted parts can be adjacent. */
export function parseArgs(str: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let inQuote = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = '';
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      inArg = true;
    } else if (ch === ' ' || ch === '\t') {
      if (inArg) {
        args.push(current);
        current = '';
        inArg = false;
      }
    } else {
      current += ch;
      inArg = true;
    }
  }
  if (inArg) {
    args.push(current);
  }
  return args;
}

/** Inverse of parseArgs: parseArgs(formatArgs(args)) gives back the same list. */
export function formatArgs(args: string[]): string {
  return args.map((arg) => {
    if (arg && !/[\s"']/.test(arg)) {
      return arg;
    }
    if (!arg.includes('"')) {
      return '"' + arg + '"';
    }
    if (!arg.includes("'")) {
      return "'" + arg + "'";
    }
    // Both kinds of quote: each " goes in single quotes, the rest in double quotes; parseArgs joins the parts.
    return arg.split('"').map((part) => (part ? '"' + part + '"' : '')).join("'\"'");
  }).join(' ');
}
