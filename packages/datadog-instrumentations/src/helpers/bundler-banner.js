'use strict'

/**
 * @typedef {object} BundlerRecord
 * @property {string[]} bundlers Bundlers whose generated code has executed.
 * @property {(bundler: string) => void} [onBundle] Installed by the runtime for bundles loaded after it.
 */

/**
 * Shared startup protocol for bundles, including when dd-trace is external or preloaded.
 * Bundles keep this code from build time while the runtime may come from another dd-trace version (external,
 * preloaded, layers, Single Step Instrumentation), so the record shape and the `onBundle` call are a frozen contract:
 * only add to them in ways both older bundles and older runtimes ignore.
 * Keep this on one line so prepending it shifts generated lines predictably.
 * @param {string} bundler
 */
module.exports = function createBundlerBanner (bundler) {
  return '((r,b)=>{r.bundlers.push(b);r.onBundle?.(b)})(' +
    `globalThis[Symbol.for("dd-trace:bundler")]??={bundlers:[]},${JSON.stringify(bundler)});`
}
