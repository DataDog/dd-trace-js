'use strict'

// Loads an optional peer through a require bundlers cannot follow: the package name is an
// argument, not a `require('literal')`, so a build that does not install the peer never pulls
// in its (possibly optional) dependency chain (#8635). When the peer is installed at build
// time, the webpack and esbuild plugins rewrite `requireOptionalPeer('name')` into a literal
// `require('name')` so the peer is bundled and survives the bundle being relocated without it
// on disk (#8980). See `optional-peer-bundler.js` for the build-time half.

/**
 * @param {string} request - Module specifier of the optional peer
 */
module.exports = function requireOptionalPeer (request) {
  // eslint-disable-next-line camelcase, no-undef
  const runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require
  return runtimeRequire(request)
}
