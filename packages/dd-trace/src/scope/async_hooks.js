'use strict'

const asyncHooks = require('./async_hooks/index')
const eid = asyncHooks.executionAsyncId
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
    this._hook = asyncHooks.createHook({
      init: this._init.bind(this),
      destroy: this._destroy.bind(this),
      promiseResolve: this._destroy.bind(this)
    })

    this._hook.enable()
  }

  _active () {
    return this._spans[eid()]
  }

  _enter (span) {
    this._spans[eid()] = span
  }

  _exit (span) {
    const asyncId = eid()

    if (span) {
      this._spans[asyncId] = span
    } else {
      delete this._spans[asyncId]
    }
  }

  _init (asyncId, type, triggerAsyncId, resource) {
    this._spans[asyncId] = this._active()
    this._types[asyncId] = type

    if (hasKeepAliveBug && (type === 'TCPWRAP' || type === 'HTTPPARSER')) {
      this._destroy(this._weaks.get(resource))
      this._weaks.set(resource, asyncId)
    }

    platform.metrics().increment('async.resources')
    platform.metrics().increment('async.resources.by.type', `resource_type:${type}`)
  }

  _destroy (asyncId) {
    const type = this._types[asyncId]

    if (type) {
      platform.metrics().decrement('async.resources')
      platform.metrics().decrement('async.resources.by.type', `resource_type:${type}`)
    }

    delete this._spans[asyncId]
    delete this._types[asyncId]
  }
}

module.exports = Scope
