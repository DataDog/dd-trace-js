'use strict'

const dc = require('dc-polyfill')
const instrumentations = require('./instrumentations')
const { AsyncResource } = require('async_hooks')

const channelMap = {}
exports.channel = function (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

const tracingChannelMap = {}
exports.tracingChannel = function (name) {
  const maybe = tracingChannelMap[name]
  if (maybe) return maybe
  const tc = dc.tracingChannel(name)
  tracingChannelMap[name] = tc
  return tc
}

/**
 * @param {object} args
 * @param {string|string[]} args.name module name
 * @param {string[]} args.versions array of semver range strings
 * @param {string} [args.file='index.js'] path to file within package to instrument
 * @param {string} [args.filePattern] pattern to match files within package to instrument
 * @param Function hook
 */
exports.addHook = function addHook ({ name, versions, file, filePattern, patchDefault }, hook) {
  if (typeof name === 'string') {
    name = [name]
  }

  for (const val of name) {
    if (!instrumentations[val]) {
      instrumentations[val] = []
    }
    instrumentations[val].push({ name: val, versions, file, filePattern, hook, patchDefault })
  }
}

exports.AsyncResource = AsyncResource
