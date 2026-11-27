'use strict'

// Async loader results cross a worker boundary, so the marker travels with the rewritten source.
const marker = '\n/* dd-trace:orchestrion-rewritten */'
// Keep the directive split so source-map scanners don't pick up this string as the file's own map.
// eslint-disable-next-line unicorn/no-useless-concat
const sourceMapDirective = '//# sourceMapping' + 'URL='

/**
 * @param {string} source
 */
function addRewriteMarker (source) {
  const index = getMarkerPosition(source)
  return source.slice(0, index) + marker + source.slice(index)
}

/**
 * @param {unknown} source
 */
function hasRewriteMarker (source) {
  return typeof source === 'string' && source.endsWith(marker, getMarkerPosition(source))
}

/**
 * @param {string} source
 */
function getMarkerPosition (source) {
  // Keep the inline source-map directive emitted by the rewriter on the final line.
  const lastNewline = source.lastIndexOf('\n')
  return lastNewline !== -1 && source.startsWith(sourceMapDirective, lastNewline + 1) ? lastNewline : source.length
}

module.exports = { addRewriteMarker, hasRewriteMarker }
