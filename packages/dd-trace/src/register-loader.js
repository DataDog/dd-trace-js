'use strict'

// CommonJS and ESM preloads can both be used in the same process.
let registered = false

/**
 * @param {typeof import('node:module').register | undefined} registerAsync
 * @param {URL} parentURL
 * @param {() => boolean | undefined} [tryRegisterSync] Returns undefined when sync hooks are unsupported.
 */
function registerLoader (registerAsync, parentURL, tryRegisterSync) {
  if (registered) return

  let syncResult
  let syncError
  try {
    syncResult = tryRegisterSync?.()
  } catch (error) {
    syncResult = false
    syncError = error
  }

  if (syncResult) {
    registered = true
    handOverRewrite(true)
    return
  }

  if (syncResult === false) {
    let message = 'dd-trace could not register synchronous loader hooks.'
    if (registerAsync) message += ' Falling back to the asynchronous loader.'
    if (syncError?.message) message += ` ${syncError.message}`
    process.emitWarning(message)
  }

  // Node.js removes module.register in nodejs/node#67090.
  if (registerAsync) {
    const { getLoaderRegisterOptions } = require('./esm-module-load')
    handOverRewrite(false)
    registerAsync('./loader-hook.mjs', parentURL, getLoaderRegisterOptions())
    registered = true
  }
}

/**
 * The loader's hooks rewrite ES modules from now on, in place of the tracer's own synchronous rewriter hook.
 *
 * @param {boolean} sync Whether the loader runs as synchronous hooks.
 */
function handOverRewrite (sync) {
  require('../../datadog-instrumentations/src/helpers/rewriter/module-hooks').handOverToLoader(sync)
}

module.exports = registerLoader
