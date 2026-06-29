'use strict'

const path = require('node:path')

// Build-time half of the optional-peer mechanism shared by the webpack and esbuild plugins.
//
// Runtime files load an optional peer through `requireOptionalPeer('name')` (see
// `require-optional-peer.js`), which bundlers cannot follow, so a build that does not opt into
// the feature never pulls in the peer's (possibly optional) dependency chain (#8635). When the
// peer is installed at build time the user has opted in, so the plugins rewrite the call into a
// literal `require('name')` and let the bundler inline the peer, which keeps it working after
// the bundle is relocated to a tree without the peer on disk (#8980). Peers that are absent at
// build time stay opaque, so the rewrite is a no-op and the #8635 guarantee holds.

// Files that load an optional peer this way, as suffixes of the resolved module path. The same
// suffix matches the repo layout and `node_modules/dd-trace`. Add a file here to extend the
// mechanism to a new optional peer; no plugin change is needed.
const OPTIONAL_PEER_FILES = [
  'packages/dd-trace/src/openfeature/flagging_provider.js',
]

// Captures the peer name from `requireOptionalPeer('name')` / `requireOptionalPeer("name")`.
const OPTIONAL_PEER_LOAD = /requireOptionalPeer\((['"])(.+?)\1\)/g

// esbuild's `onLoad` needs a path filter; match the basenames so the callback only fires for
// the candidate files, then `matchesOptionalPeerFile` confirms the full suffix on a normalized
// path (basenames carry no separators, so the filter is OS-agnostic).
const OPTIONAL_PEER_FILTER = new RegExp(
  `(?:${OPTIONAL_PEER_FILES.map((file) => path.basename(file).replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|')})$`
)

/**
 * @param {string} normalizedResource - Resolved module path with forward slashes
 * @returns {boolean} Whether the module is one of the optional-peer loader files
 */
function matchesOptionalPeerFile (normalizedResource) {
  return OPTIONAL_PEER_FILES.some((suffix) => normalizedResource.endsWith(suffix))
}

/**
 * Rewrites each `requireOptionalPeer('name')` whose peer resolves from `fromDir` into a literal
 * `require('name')` so the bundler inlines it. Peers that do not resolve stay opaque, so a build
 * without the peer keeps the #8635 guarantee.
 *
 * @param {string} source - Source of an optional-peer loader file
 * @param {string} fromDir - Directory to resolve the optional peers from
 * @returns {string} Source with installed optional peers turned into literal requires
 */
function rewriteOptionalPeerLoads (source, fromDir) {
  return source.replaceAll(OPTIONAL_PEER_LOAD, (match, _quote, request) => {
    try {
      require.resolve(request, { paths: [fromDir] })
    } catch {
      return match
    }
    return `require('${request}')`
  })
}

module.exports = {
  OPTIONAL_PEER_FILES,
  OPTIONAL_PEER_FILTER,
  matchesOptionalPeerFile,
  rewriteOptionalPeerLoads,
}
