'use strict'

// Build-time support shared by the webpack and esbuild plugins for the optional
// OpenFeature peer `@datadog/openfeature-node-server`.
//
// `flagging_provider.js` loads the peer through a bundler-opaque require so a build
// that does not opt into feature flagging never follows the optional peer chain
// `@datadog/openfeature-node-server` -> `@openfeature/server-sdk` -> `@openfeature/core`
// (#8635). The trade-off is that the peer is then not bundled, so a bundle relocated
// to a tree without the peer on disk (standalone deploys) silently falls back to the
// no-op provider (#8980). When the peer is installed at build time the user has opted
// in, so the plugins rewrite the opaque load into a literal require and let the bundler
// inline the peer, which keeps feature flagging working after relocation.

const OPENFEATURE_PEER = '@datadog/openfeature-node-server'

// Internal path of dd-trace's OpenFeature provider, identical in the repo layout and
// inside `node_modules/dd-trace`. Bundler plugins match the module they rewrite against it.
const FLAGGING_PROVIDER_SUFFIX = 'packages/dd-trace/src/openfeature/flagging_provider.js'

// The two opaque-load lines in `flagging_provider.js`, kept in sync by the throw below.
const OPAQUE_RESOLVE = 'runtimeRequire.resolve(openfeatureNodeServer, { paths: [__dirname] })'
const OPAQUE_REQUIRE = 'runtimeRequire(openfeatureNodeServerPath)'

/**
 * @param {string} fromDir - Directory to resolve the optional peer from
 * @returns {boolean} Whether `@datadog/openfeature-node-server` is installed and resolvable
 */
function isOpenFeaturePeerInstalled (fromDir) {
  try {
    require.resolve(OPENFEATURE_PEER, { paths: [fromDir] })
    return true
  } catch {
    return false
  }
}

/**
 * Rewrites the bundler-opaque peer load in `flagging_provider.js` into a literal require
 * so the bundler inlines the optional peer. Drops the opaque resolve so it cannot run
 * against a non-existent path inside the bundle.
 *
 * @param {string} source - Source of `flagging_provider.js`
 * @returns {string} Source with the peer require turned literal
 */
function rewriteFlaggingProviderSource (source) {
  if (!source.includes(OPAQUE_REQUIRE)) {
    throw new Error(
      'The OpenFeature provider load shape changed; update ' +
      'packages/datadog-instrumentations/src/helpers/openfeature-bundler.js to match flagging_provider.js'
    )
  }

  return source
    .replace(OPAQUE_RESOLVE, "''")
    .replace(OPAQUE_REQUIRE, `require('${OPENFEATURE_PEER}')`)
}

module.exports = {
  OPENFEATURE_PEER,
  FLAGGING_PROVIDER_SUFFIX,
  isOpenFeaturePeerInstalled,
  rewriteFlaggingProviderSource,
}
