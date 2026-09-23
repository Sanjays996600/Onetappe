// Metro for a pnpm workspace: compile the workspace packages (@onetappe/*) from their
// TypeScript sources via the "source" export condition, so no separate build is needed.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const packagesDir = path.resolve(__dirname, '../../packages');

config.resolver.unstable_conditionNames = [
  'source',
  ...(config.resolver.unstable_conditionNames ?? ['require', 'import', 'react-native']),
];

// The packages are ES modules written for Node, so their relative imports say "./x.js"
// for a source file "./x.ts". Metro does not map those; try the TypeScript file first.
const defaultResolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  if (
    moduleName.startsWith('.') &&
    moduleName.endsWith('.js') &&
    context.originModulePath.startsWith(packagesDir)
  ) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Fall through to the name as written.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
