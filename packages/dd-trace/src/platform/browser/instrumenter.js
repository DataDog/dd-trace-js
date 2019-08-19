'use strict'

const shimmer = require('shimmer')
const log = require('../../log')

// TODO: refactor to share code between Node and the browser

shimmer({ logger: () => {} })

const plugins = require('../../plugins/browser')

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._enabled = false
    this._names = new Set()
    this._plugins = new Map()
    this._instrumented = new Set()
  }

  use (name, config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }

    config = config || {}

    try {
      this._set(plugins[name.toLowerCase()], { name, config })
    } catch (e) {
      log.debug(`Could not find a plugin named "${name}".`)
    }
  }

  patch (config) {
    config = config || {}

    if (config.plugins !== false) {
      Object.keys(plugins)
        .filter(name => !this._plugins.has(plugins[name]))
        .forEach(name => {
          this._set(plugins[name], { name, config: {} })
        })
    }
  }

  unpatch () {
    this._instrumented.forEach(instrumentation => {
      this._unpatch(instrumentation)
    })

    this._plugins.clear()
  }

  wrap (nodules, names, wrapper) {
    nodules = [].concat(nodules)
    names = [].concat(names)

    nodules.forEach(nodule => {
      names.forEach(name => {
        if (typeof nodule[name] !== 'function') {
          throw new Error(`Expected object ${nodule} to contain method ${name}.`)
        }

        Object.defineProperty(nodule[name], '_datadog_patched', {
          value: true,
          configurable: true
        })
      })
    })

    shimmer.massWrap.call(this, nodules, names, wrapper)
  }

  unwrap (nodules, names, wrapper) {
    nodules = [].concat(nodules)
    names = [].concat(names)

    shimmer.massUnwrap.call(this, nodules, names, wrapper)

    nodules.forEach(nodule => {
      names.forEach(name => {
        nodule[name] && delete nodule[name]._datadog_patched
      })
    })
  }

  enable () {
    this._enabled = true
  }

  _set (plugin, meta) {
    this._unload(plugin)
    this._plugins.set(plugin, meta)
    this._load(plugin, meta)
  }

  _unload (plugin) {
    [].concat(plugin)
      .forEach(instrumentation => {
        this._unpatch(instrumentation)
        this._instrumented.delete(instrumentation)
      })

    this._plugins.delete(plugin)
  }

  _patch (instrumentation, module, config) {
    if (!this._instrumented.has(instrumentation)) {
      this._instrumented.add(instrumentation)
      return instrumentation.patch.call(this, module, this._tracer._tracer, config)
    }
  }

  _unpatch (instrumentation) {
    if (this._instrumented.has(instrumentation)) {
      try {
        instrumentation.unpatch.call(this, window[instrumentation.name], this._tracer)
      } catch (e) {
        log.error(e)
      }
    }
  }

  _load (plugin, meta) {
    if (this._enabled) {
      const instrumentations = [].concat(plugin)

      try {
        instrumentations
          .forEach(instrumentation => {
            this._patch(instrumentation, window[instrumentation.name], meta.config)
          })
      } catch (e) {
        log.error(e)
        this._unload(plugin)
        log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)
      }
    }
  }
}

module.exports = Instrumenter
