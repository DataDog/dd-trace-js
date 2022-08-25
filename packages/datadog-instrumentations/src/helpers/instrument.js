'use strict'

const dc = require('diagnostics_channel')
const semver = require('semver')
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

exports.addHook = function addHook ({ name, versions, file }, hook) {
  if (!instrumentations[name]) {
    instrumentations[name] = []
  }

  instrumentations[name].push({ name, versions, file, hook })
}

exports.TracingChannel = class TracingChannel {
  constructor (name) {
    this._name = name
    this._channels = {
      start: dc.channel(`${name}.start`),
      end: dc.channel(`${name}.end`),
      asyncEnd: dc.channel(`${name}.asyncEnd`),
      error: dc.channel(`${name}.error`)
    }
  }

  get hasSubscribers () {
    return this._channels.start.hasSubscribers
  }

  publish (channelName, data) {
    return dc.channel(`${this.name}.${channelName}`).publish(data)
  }

  trace (fn, ctx = {}) {
    this._channels.start.publish(ctx)
    try {
      if (fn.length) {
        const done = (...args) => {
          const [e, val] = args
          if (args.length > 1) {
            ctx.result = val
          }
          if (e) {
            ctx.error = e
            this._channels.error.publish(ctx)
          }
          this._channels.asyncEnd.publish(ctx)
        }
        return fn(done)
      } else {
        const result = fn()
        if ((typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
          result.then(resolved => {
            ctx.result = resolved
            this._channels.asyncEnd.publish(ctx)
          }, e => {
            ctx.error = e
            this._channels.error.publish(ctx)
            this._channels.asyncEnd.publish(ctx)
          })
        } else {
          ctx.result = result
        }
        return result
      }
    } catch (e) {
      ctx.error = e
      this._channels.error.publish(ctx)
      throw e
    } finally {
      this._channels.end.publish(ctx)
    }
  }

  subscribe (handlerObj) {
    for (const key in handlerObj) {
      this._channels[key].subscribe(handlerObj[key])
    }
  }

  unsubscribe (handlerObj) {
    for (const key in handlerObj) {
      this._channels[key].unsubscribe(handlerObj[key])
    }
  }
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
