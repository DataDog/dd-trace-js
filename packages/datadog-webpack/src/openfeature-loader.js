'use strict'

// Marks the spot in `flagging_provider.js` that loads the optional peer through the
// bundler-opaque escape hatch. Kept in sync by the throw below.
const OPAQUE_RESOLVE = 'runtimeRequire.resolve(openfeatureNodeServer, { paths: [__dirname] })'
const OPAQUE_REQUIRE = 'runtimeRequire(openfeatureNodeServerPath)'

/**
 * Webpack loader applied to `flagging_provider.js` only when
 * `@datadog/openfeature-node-server` resolves at build time. It turns the opaque
 * runtime require into a literal one so webpack bundles the optional peer into the
 * output, which keeps feature flagging working after the bundle is relocated to a
 * tree without the peer on disk (standalone deploys, see #8980). The opaque shape
 * stays in the source for plain bundlers and for builds without the peer installed,
 * so #8635 (build failure on the optional peer chain) does not regress.
 *
 * @param {string} source
 * @returns {string}
 */
module.exports = function openFeatureLoader (source) {
  this.cacheable(false)

  if (!source.includes(OPAQUE_REQUIRE)) {
    throw new Error(
      'DatadogWebpackPlugin: the OpenFeature provider load shape changed; ' +
      'update packages/datadog-webpack/src/openfeature-loader.js to match flagging_provider.js'
    )
  }

  return source
    .replace(OPAQUE_RESOLVE, "''")
    .replace(OPAQUE_REQUIRE, "require('@datadog/openfeature-node-server')")
}
