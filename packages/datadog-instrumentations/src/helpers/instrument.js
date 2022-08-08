'use strict'

const dc = require('diagnostics_channel')
const semver = require('semver')
const instrumentations = require('./instrumentations')
const { AsyncResource } = require('async_hooks')

require('./register')

const channelMap = {}
exports.channel = function (name) {
  const maybe = channelMap[name]
  if (maybe) return maybe
  const ch = dc.channel(name)
  channelMap[name] = ch
  return ch
}

exports.addHook = function addHook ({ name, versions, file }, hook) {
  if (!instrumentations[name]) {
    instrumentations[name] = []
  }

  instrumentations[name].push({ name, versions, file, hook })
}

// AsyncResource.bind exists and binds `this` properly only from 17.8.0 and up.
// https://nodejs.org/api/async_context.html#asyncresourcebindfn-thisarg
if (semver.satisfies(process.versions.node, '>=17.8.0')) {
  exports.AsyncResource = AsyncResource
} else {
  exports.AsyncResource = class extends AsyncResource {
    static bind (fn, type, thisArg) {
      type = type || fn.name
      return (new exports.AsyncResource(type || 'bound-anonymous-fn')).bind(fn, thisArg)
    }

    bind (fn, thisArg) {
      let bound
      if (thisArg === undefined) {
        const resource = this
        bound = function (...args) {
          args.unshift(fn, this)
          return Reflect.apply(resource.runInAsyncScope, resource, args)
        }
      } else {
        bound = this.runInAsyncScope.bind(this, fn, thisArg)
      }
      Object.defineProperties(bound, {
        'length': {
          configurable: true,
          enumerable: false,
          value: fn.length,
          writable: false
        },
        'asyncResource': {
          configurable: true,
          enumerable: true,
          value: this,
          writable: true
        }
      })
      return bound
    }
  }
}
