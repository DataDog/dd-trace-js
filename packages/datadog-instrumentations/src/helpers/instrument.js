'use strict'

const dc = /** @type {typeof import('node:diagnostics_channel')} */ (require('dc-polyfill'))
const instrumentations = require('./instrumentations')
const { AsyncResource } = require('async_hooks')

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
 * @param {object} args
 * @param {string} args.name module name
 * @param {string[]} [args.versions] array of semver range strings
 * @param {string} [args.file='index.js'] path to file within package to instrument
 * @param {string} [args.filePattern] pattern to match files within package to instrument
 * @param {boolean} [args.patchDefault=true] whether to patch the default export
 * @param {import('./instrumentations').Hook} hook
 */
exports.addHook = function addHook ({ name, versions, file, filePattern, patchDefault }, hook) {
  if (!instrumentations[name]) {
    instrumentations[name] = []
  }

  instrumentations[name].push({ versions, file, filePattern, hook, patchDefault })
}

exports.AsyncResource = AsyncResource
