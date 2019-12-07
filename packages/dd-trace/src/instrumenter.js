'use strict'

const shimmer = require('shimmer')
const log = require('./log')
const platform = require('./platform')

shimmer({ logger: () => {} })

const plugins = platform.plugins

const disabldPlugins = platform.env('DD_TRACE_DISABLED_PLUGINS')

const collectDisabledPlugins = () => {
  return new Set(disabldPlugins && disabldPlugins.split(',').map(plugin => plugin.trim()))
}

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._loader = new platform.Loader(this)
    this._enabled = false
    this._names = new Set()
    this._plugins = new Map()
    this._instrumented = new Map()
    this._disabledPlugins = collectDisabledPlugins()
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

    if (this._enabled) {
      this._loader.reload(this._plugins)
    }
  }

  enable (config) {
    config = config || {}

    this._enabled = true

    if (config.plugins !== false) {
      Object.keys(plugins)
        .filter(name => !this._plugins.has(plugins[name]))
        .forEach(name => {
          this._set(plugins[name], { name, config: {} })
        })
    }

    this._loader.reload(this._plugins)
  }

  disable () {
    for (const instrumentation of this._instrumented.keys()) {
      this.unpatch(instrumentation)
    }

    this._plugins.clear()
    this._enabled = false
    this._loader.reload(this._plugins)
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

  load (plugin, meta) {
    if (!this._enabled) return

    const instrumentations = [].concat(plugin)
    const enabled = meta.config.enabled !== false

    platform.metrics().boolean(`datadog.tracer.node.plugin.enabled.by.name`, enabled, `name:${meta.name}`)

    try {
      instrumentations
        .forEach(instrumentation => {
          this._loader.load(instrumentation, meta.config)
        })
    } catch (e) {
      log.error(e)
      this.unload(plugin)
      log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)

      platform.metrics().increment(`datadog.tracer.node.plugin.errors`, true)
    }
  }

  unload (plugin) {
    [].concat(plugin)
      .forEach(instrumentation => {
        this.unpatch(instrumentation)
        this._instrumented.delete(instrumentation)
      })

    const meta = this._plugins.get(plugin)

    if (meta) {
      this._plugins.delete(plugin)

      platform.metrics().boolean(`datadog.tracer.node.plugin.enabled.by.name`, false, `name:${meta.name}`)
    }
  }

  patch (instrumentation, moduleExports, config) {
    let instrumented = this._instrumented.get(instrumentation)

    if (!instrumented) {
      this._instrumented.set(instrumentation, instrumented = new Set())
    }

    if (!instrumented.has(moduleExports)) {
      instrumented.add(moduleExports)
      return instrumentation.patch.call(this, moduleExports, this._tracer._tracer, config)
    }
  }

  unpatch (instrumentation) {
    const instrumented = this._instrumented.get(instrumentation)

    if (instrumented) {
      instrumented.forEach(moduleExports => {
        try {
          instrumentation.unpatch.call(this, moduleExports, this._tracer)
        } catch (e) {
          log.error(e)
        }
      })
    }
  }

  _set (plugin, meta) {
    if (this._disabledPlugins.has(meta.name)) {
      log.debug(`Plugin "${meta.name}" was disabled via configuration option.`)
    } else {
      this._plugins.set(plugin, meta)
      this.load(plugin, meta)
    }
  }
}

module.exports = Instrumenter
