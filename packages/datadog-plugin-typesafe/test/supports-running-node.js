'use strict'

const semver = require('semver')

/**
 * Whether the installed SDK version supports the running Node.js, per its own `engines.node`. Versions differ
 * (0.6.0 supports Node.js 20, 0.7.0 needs 22), so this gates each version rather than the whole suite.
 * `DD_INJECT_FORCE` runs every version anyway, as `withVersions` does for the tracer's own engines range.
 *
 * @param {{ pkgJsonPath: () => string }} versionModule - The `versions/@typesafe-ai/sdk@<version>` wrapper
 */
function supportsRunningNode (versionModule) {
  if (process.env.DD_INJECT_FORCE) return true
  const { engines } = require(versionModule.pkgJsonPath())
  return !engines?.node || semver.satisfies(process.version, engines.node)
}

module.exports = { supportsRunningNode }
