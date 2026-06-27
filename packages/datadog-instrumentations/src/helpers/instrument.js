'use strict'

const { AsyncResource } = require('async_hooks')
const dc = /** @type {typeof import('node:diagnostics_channel')} */ (require('dc-polyfill'))
const instrumentations = require('./instrumentations')
const rewriterInstrumentations = require('./rewriter/instrumentations')

/**
 * @typedef {import('node:diagnostics_channel').Channel} Channel
 * @typedef {import('node:diagnostics_channel').TracingChannel} TracingChannel
 */

/**
 * @type {Record<string, Channel>}
 */
const channelMap = {}
/**
 * @param {string} name
 * @returns {Channel}
 */
exports.channel = function (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

/**
 * @type {Record<string, TracingChannel>}
 */
const tracingChannelMap = {}
/**
 * @param {string} name
 * @returns {TracingChannel}
 */
exports.tracingChannel = function (name) {
  const maybe = tracingChannelMap[name]
  if (maybe) return maybe
  const tc = dc.tracingChannel(name)
  tracingChannelMap[name] = tc
  return tc
}

/**
 * Build a guarded publisher for a public error channel. A channel subscriber
 * that drives another wrapped hook while handling the error, and fastify's boot
 * loop re-invoking the same encapsulated hook (avvio's `_encapsulateThreeParam`)
 * after a throw, both republish here and recurse until the stack overflows
 * (#8783, #9099). Two guards bound both shapes:
 *
 * 1. `publishing` blocks a synchronous re-entry — any error republished while a
 *    publish is still on the stack — the way the original boolean did.
 * 2. `lastError` blocks a sequential re-drive of the same error after the publish
 *    returned. The boolean alone cannot, because its `finally` clears the flag
 *    before the next re-drive runs, and the error that rides the re-drives (a
 *    persistent `DatadogRaspAbortError`, the boot deprecation error) is the same
 *    object on every hop, so a single reference compare against the previous
 *    publish terminates the loop. This costs one comparison rather than a
 *    `WeakSet` lookup on every publish, and it does not mutate the error.
 *
 * A genuinely distinct error still reaches its subscribers. The only case this
 * does not collapse is a re-drive that alternates between two distinct persistent
 * errors on the same channel, which is not a shape fastify's hook re-drive
 * produces (it re-throws the one caught error).
 *
 * @param {Channel} errorChannel
 */
exports.createErrorPublisher = function createErrorPublisher (errorChannel) {
  let publishing = false
  let lastError
  /** @param {{ error?: unknown }} message */
  return function publishError (message) {
    if (publishing) return

    // The re-drive re-throws the same error object on every hop, so a compare
    // against the previously published error terminates it. `undefined` is never
    // a re-drive sentinel: callers gate on `ctx.error` being truthy before
    // reaching here, so an undefined error simply falls through to the guard.
    const error = message.error
    if (error !== undefined && error === lastError) return
    lastError = error

    publishing = true
    try {
      errorChannel.publish(message)
    } finally {
      publishing = false
    }
  }
}

exports.getHooks = function getHooks (names) {
  names = [names].flat()

  return rewriterInstrumentations
    .map(inst => inst.module)
    .filter(({ name }) => names.includes(name))
    .map(({ name, versionRange, filePath }) => ({ name, versions: [versionRange], file: filePath }))
}

/**
 * @param {object} args
 * @param {string} args.name module name
 * @param {string[]} [args.versions] array of semver range strings
 * @param {string} [args.file] path to file within package to instrument. Defaults to 'index.js'.
 * @param {string} [args.filePattern] pattern to match files within package to instrument
 * @param {boolean} [args.patchDefault] whether to patch the default export. Defaults to true.
 * @param {(moduleExports: unknown, version: string, isIitm?: boolean, hookMeta?: object) => unknown} [hook]
 * Patches module exports
 */
exports.addHook = function addHook ({ name, versions, file, filePattern, patchDefault }, hook) {
  if (!instrumentations[name]) {
    instrumentations[name] = []
  }

  instrumentations[name].push({ versions, file, filePattern, hook, patchDefault })
}

exports.AsyncResource = AsyncResource
