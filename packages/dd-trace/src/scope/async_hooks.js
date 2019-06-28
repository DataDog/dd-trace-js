'use strict'

const asyncHooks = require('./async_hooks/index')
const Base = require('./base')
const platform = require('../platform')
const semver = require('semver')

// https://github.com/nodejs/node/issues/19859
const hasKeepAliveBug = !semver.satisfies(process.version, '^8.13 || >=10.14.2')

let singleton = null

class Scope extends Base {
  constructor () {
    if (singleton) return singleton

    super()

    singleton = this

    this._spans = Object.create(null)
    this._types = Object.create(null)
    this._weaks = new WeakMap()
    this._refs = new WeakMap()
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      before: this._before.bind(this),
      after: this._after.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._promiseResolve.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._current
  }

  _enter (span) {
    this._current = span
  }

  _exit (span) {
    this._current = span
  }

  _wipe (span) {
    const ids = this._refs.get(span)

    if (ids) {
      ids.forEach(asyncId => {
        delete this._spans[asyncId]
      })

      this._refs.delete(span)
    }
  }

  _ref (span, asyncId) {
    this._spans[asyncId] = span

    if (span) {
      const ids = this._refs.get(span)

      if (ids) {
        ids.add(asyncId)
      } else {
        this._refs.set(span, new Set([asyncId]))
      }
    }
  }

  _unref (span, asyncId) {
    delete this._spans[asyncId]

    if (span) {
      const ids = this._refs.get(span)

      if (ids) {
        ids.delete(asyncId)
      }
    }
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    const span = this._active()

    this._ref(span, asyncId)

    this._types[asyncId] = type

    if (hasKeepAliveBug && (type === 'TCPWRAP' || type === 'HTTPPARSER')) {
      this._destroy(this._weaks.get(resource))
      this._weaks.set(resource, asyncId)
    }

    platform.metrics().increment('async.resources')
    platform.metrics().increment('async.resources.by.type', `resource_type:${type}`)
  }

  _before (asyncId) {
    this._current = this._spans[asyncId]
  }

  _after () {
    delete this._current
  }

  _destroy (asyncId) {
    const span = this._spans[asyncId]
    const type = this._types[asyncId]

    this._unref(span, asyncId)

    delete this._types[asyncId]

    if (type) {
      platform.metrics().decrement('async.resources')
      platform.metrics().decrement('async.resources.by.type', `resource_type:${type}`)
    }
  }

  _promiseResolve (asyncId) {
    delete this._spans[asyncId]
  }
}

module.exports = Scope
