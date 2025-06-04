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

/**
 * @param {string} args.name module name
 * @param {string[]} args.versions array of semver range strings
 * @param {string} args.file path to file within package to instrument
 * @param {string} args.filePattern pattern to match files within package to instrument
 * @param Function hook
 */
exports.addHook = function addHook ({ name, versions, file, filePattern }, hook) {
  if (typeof name === 'string') {
    name = [name]
  }

  for (const val of name) {
    if (!instrumentations[val]) {
      instrumentations[val] = []
    }
    instrumentations[val].push({ name: val, versions, file, filePattern, hook })
  }
}

exports.AsyncResource = AsyncResource
