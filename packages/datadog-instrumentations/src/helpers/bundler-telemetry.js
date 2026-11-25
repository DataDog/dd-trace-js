'use strict'

const bundlers = /** @type {const} */ (['esbuild', 'turbopack', 'vite', 'webpack'])

/**
 * @param {typeof bundlers[number]} bundler
 */
function markerKey (bundler) {
  return `dd-trace:bundler:${bundler}`
}

/**
 * The bundle leaves a marker even if the tracer loads later or is external to the bundle.
 *
 * @param {typeof bundlers[number]} bundler
 */
function bundlerMarker (bundler) {
  return `\n;try { globalThis[Symbol.for(${JSON.stringify(markerKey(bundler))})] = true } catch {}\n`
}

module.exports = { bundlerMarker, bundlers, markerKey }
