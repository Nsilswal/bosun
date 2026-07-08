// Expo auto-configures monorepo support (watchFolders, nodeModulesPaths).
// We only opt into package-`exports` resolution, which the `@bosun/*`
// workspace packages use for their subpath entry points (e.g.
// `@bosun/transport/client-core`).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
