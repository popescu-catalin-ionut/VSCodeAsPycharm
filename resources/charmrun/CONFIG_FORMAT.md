# Configuration Format

CharmRun stores managed run configurations in:

`<workspace>/.vscode/launch.json`

CharmRun only manages Python `debugpy` launch entries that it created itself or that the user explicitly adopted.

## Managed Entry Shape

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run API Server",
      "type": "debugpy",
      "request": "launch",
      "program": "src/api/main.py",
      "args": ["--port", "8000"],
      "cwd": "${workspaceFolder}",
      "env": {
        "ENV": "dev"
      },
      "console": "integratedTerminal",
      "justMyCode": true,
      "charmrunManaged": true,
      "charmrunId": "uuid-v4-like-string",
      "charmrunRunMode": "run",
      "charmrunPreRun": [
        {
          "id": "uuid-v4-like-string",
          "type": "externalTool",
          "enabled": true,
          "configId": "",
          "command": "npm",
          "args": ["run", "build"],
          "cwd": "${workspaceFolder}",
          "task": ""
        }
      ]
    }
  ]
}
```

## Mapping

- `name` -> `name`
- `runType = "script"` -> `program`
- `runType = "module"` -> `module`
- `interpreter` -> `python` when a custom interpreter is set
- `interpreter = "selected"` -> omit `python` so VS Code/Python uses the selected interpreter
- `args` -> `args`
- `cwd` -> `cwd`
- `env` -> `env`
- `envFile` -> `envFile` (omitted when empty)
- `terminal` -> `console`
- `runMode` -> `charmrunRunMode`
- `preRun` -> `charmrunPreRun` (omitted when there are no steps)

CharmRun metadata:

- `charmrunManaged: true`
- `charmrunId: string`
- `charmrunRunMode: "run" | "debug"`
- `charmrunPreRun: PreRunStep[]`

## Before Launch Steps

Each entry in `charmrunPreRun` describes one step to run before the
configuration launches. Steps run in array order; disabled steps are skipped.

| Field | Applies to | Meaning |
|-------|-----------|---------|
| `id` | all | Stable step identifier |
| `type` | all | `configuration`, `externalTool`, or `task` |
| `enabled` | all | `false` skips the step without deleting it |
| `configId` | `configuration` | `charmrunId` of another managed configuration |
| `command` | `externalTool` | Executable or command to run |
| `args` | `externalTool` | Arguments passed to the command |
| `cwd` | `externalTool` | Working directory (defaults to the workspace folder) |
| `task` | `task` | Task label, e.g. `build` or `npm: test` |

Behavior:

- A step of type `configuration` launches the referenced configuration and waits
  for its debug session to terminate. VS Code exposes no exit code for debug
  sessions, so such a step fails only when the configuration cannot start.
- A step of type `externalTool` fails on a non-zero exit code, and its output is
  written to the `CharmRun Before Launch` output channel.
- A step of type `task` fails on a non-zero task process exit code.
- Circular references between configurations are rejected when the step is
  reached, instead of recursing.
- `${...}` placeholders are expanded in `command`, `args`, and `cwd`.
- Unknown step types are dropped when `launch.json` is read.

## Adoption

Use `CharmRun: Adopt launch.json Configuration` to take over an existing Python `debugpy` launch config in place. CharmRun adds its metadata to that same `launch.json` entry and then edits it through the GUI.

## Preserved Fields

CharmRun preserves unknown fields on managed Python launch entries. Existing fields such as `justMyCode` or `subProcess` remain in `launch.json` when you edit the config in the GUI. (`envFile` is no longer in this group - it is a managed field, editable from the Env File box in the configuration editor.)

## Validation Rules

- `name` is required
- `program` is required for script configs
- `module` is required for module configs

## Variable Placeholders

CharmRun resolves:

- `${workspaceFolder}`
- `${workspaceFolderBasename}`
- `${file}`
- `${fileBasename}`
- `${fileBasenameNoExtension}`
- `${fileDirname}`
- `${fileExtname}`
- `${relativeFile}`
- `${env:VARNAME}`

## Multi-Root Behavior

Each workspace folder can have its own `.vscode/launch.json`.  
CharmRun shows all CharmRun-managed configurations across workspace folders in one tree.
