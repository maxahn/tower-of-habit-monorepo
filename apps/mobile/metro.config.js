const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.disableHierarchicalLookup = true;

// packages/shared uses "type": "module" with .js extension imports in TS
// source (Node ESM convention). Enable package exports so Metro reads the
// "exports" field and resolves from the TS source directly.
config.resolver.unstable_enablePackageExports = true;

// When resolving a bare .js import inside a .ts source file, also try .ts/.tsx.
// This handles `export * from './time/local-date.js'` in shared/src/index.ts.
config.resolver.sourceExts = [...(config.resolver.sourceExts || []), 'cjs'];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.js')) {
    const tsName = moduleName.replace(/\.js$/, '.ts');
    try {
      return context.resolveRequest(context, tsName, platform);
    } catch {
      // fall through to default
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withNativeWind(config, { input: './global.css' });
