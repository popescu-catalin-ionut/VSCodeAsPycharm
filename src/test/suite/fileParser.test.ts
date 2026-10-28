import * as assert from 'assert';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { parseFile, shouldParseFile } from '../../services/fileParser';
import { mockConfiguration } from './mocks/configuration';

// VS Code's own executable runs as plain Node with ELECTRON_RUN_AS_NODE, so the test needs no other tool.
const echoArgsRule = (args: string[]) => ({
  pattern: '*.json',
  command: process.execPath,
  args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args],
  env: { ELECTRON_RUN_AS_NODE: '1' },
});

suite('fileParsingRules: running the parse command', () => {
  let restore: (() => void) | undefined;
  let dir: string | undefined;

  teardown(() => {
    restore?.();
    if (dir) { fs.removeSync(dir); }
    restore = dir = undefined;
  });

  function fileIn(folderName: string) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspycharm-parse-'));
    const file = path.join(dir, folderName, 'data.json');
    fs.outputFileSync(file, '{}');
    return file;
  }

  async function argsFor(file: string, args: string[]): Promise<string[]> {
    restore = mockConfiguration({ fileParsingRules: [echoArgsRule(args)] });
    return JSON.parse((await parseFile(file)).parsedContent);
  }

  test('rules match by file name pattern', () => {
    restore = mockConfiguration({ fileParsingRules: [echoArgsRule([])] });
    assert.ok(shouldParseFile(path.join('x', 'y', 'a.json')));
    assert.ok(!shouldParseFile(path.join('x', 'y', 'a.txt')));
  });

  test('{file} becomes the file path', async () => {
    const file = fileIn('plain');
    assert.deepStrictEqual(await argsFor(file, ['{file}']), [file]);
  });

  test('a path containing "$&" or "$$" is passed through unchanged (bug: treated as a replacement pattern)', async () => {
    const file = fileIn('a$&b$$c');
    assert.deepStrictEqual(await argsFor(file, ['{file}']), [file]);
  });

  test('every {file} in an argument is replaced (bug: only the first)', async () => {
    const file = fileIn('twice');
    // No leading "--": Node would read it as one of its own options.
    assert.deepStrictEqual(await argsFor(file, ['in={file};out={file}.out']), [`in=${file};out=${file}.out`]);
  });
});
