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
 * Build a guarded publisher for a public error channel. A subscriber that
 * re-enters the same wrapped dispatch while handling the error would otherwise
 * republish here and recurse until the stack overflows. Each framework binds
 * its own publisher, so the in-flight flag stays private to one channel: a
 * genuinely nested error on a different framework's channel (a Koa app mounted
 * inside Express) still reaches its subscribers instead of being dropped, and
 * the guard costs a closure read rather than a per-publish channel lookup.
 *
 * @param {Channel} errorChannel
 */
exports.createErrorPublisher = function createErrorPublisher (errorChannel) {
  let publishing = false
  /** @param {object} message */
  return function publishError (message) {
    if (publishing) return
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
