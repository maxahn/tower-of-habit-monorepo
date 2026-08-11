const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// Watch the whole workspace so edits to packages/shared trigger reloads.
config.watchFolders = [workspaceRoot];

// Resolve from both the app and the root node_modules.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// Don't walk up past the workspace root looking for modules.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
