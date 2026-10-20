'use strict'

/**
 * @typedef {object} BundlerRecord
 * @property {string[]} bundlers Bundlers whose generated code has executed.
 * @property {(bundler: string) => void} [onBundle] Installed by the runtime for bundles loaded after it.
 */

/**
 * Shared startup protocol for bundles, including when dd-trace is external or preloaded.
 * Keep this on one line so prepending it shifts generated lines predictably.
 * @param {string} bundler
 */
module.exports = function createBundlerBanner (bundler) {
  return '((r,b)=>{r.bundlers.push(b);r.onBundle?.(b)})(' +
    `globalThis[Symbol.for("dd-trace:bundler")]??={bundlers:[]},${JSON.stringify(bundler)});`
}
