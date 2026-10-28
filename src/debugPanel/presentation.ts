// PyCharm groups an object's protected (_name), special (__name__) and function members under their own nodes
// ("Protected Attributes", ...). The Python debugger (debugpy) can do the same with its "variablePresentation"
// launch option; this adds it to Python debug configurations that do not set it themselves.
import { debug, DebugConfiguration, Disposable, workspace } from 'vscode';

export const PYCHARM_PRESENTATION = { special: 'group', function: 'group', protected: 'group', class: 'inline' };

export function withVariablePresentation(config: DebugConfiguration, enabled: boolean): DebugConfiguration {
  // An empty configuration means "no launch.json": leave it to the Python extension to fill in.
  if (!enabled || !PYTHON_TYPES.includes(config.type) || !config.request || config.variablePresentation !== undefined) {
    return config;
  }
  return { ...config, variablePresentation: { ...PYCHARM_PRESENTATION } };
}

// "python" is the older type name; many launch.json files still use it, and it runs debugpy too.
const PYTHON_TYPES = ['debugpy', 'python'];

export function registerVariablePresentation(): Disposable {
  const provider = {
    resolveDebugConfiguration: (_folder: unknown, config: DebugConfiguration) =>
      withVariablePresentation(config, workspace.getConfiguration('aspycharm.debug').get<boolean>('groupAttributes', true)),
  };
  return Disposable.from(...PYTHON_TYPES.map((type) => debug.registerDebugConfigurationProvider(type, provider)));
}
