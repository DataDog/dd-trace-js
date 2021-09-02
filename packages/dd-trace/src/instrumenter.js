'use strict'

const shimmer = require('../../datadog-shimmer')
const log = require('./log')
const metrics = require('./metrics')
const Loader = require('./loader')
const { isTrue } = require('./util')
const plugins = require('./plugins')

const disabldPlugins = process.env.DD_TRACE_DISABLED_PLUGINS

const collectDisabledPlugins = () => {
  return new Set(disabldPlugins && disabldPlugins.split(',').map(plugin => plugin.trim()))
}

function cleanEnv (name) {
  return process.env[`DD_TRACE_${name.toUpperCase()}`.replace(/[^a-z0-9_]/ig, '_')]
}

function getConfig (name, config = {}) {
  if (!name) {
    return config
  }

  const enabled = cleanEnv(`${name}_ENABLED`)
  if (enabled !== undefined) {
    config.enabled = isTrue(enabled)
  }

  return config
}

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._loader = new Loader(this)
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

    config = getConfig(name, config)

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
    const serviceMapping = config.serviceMapping

    this._enabled = true

    if (config.plugins !== false) {
      Object.keys(plugins)
        .filter(name => !this._plugins.has(plugins[name]))
        .forEach(name => {
          const pluginConfig = {}
          if (serviceMapping && serviceMapping[name]) {
            pluginConfig.service = serviceMapping[name]
          }
          this._set(plugins[name], { name, config: getConfig(name, pluginConfig) })
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
    shimmer.massWrap(nodules, names, wrapper)
  }

  unwrap (nodules, names, wrapper) {
    shimmer.massUnwrap(nodules, names, wrapper)
  }

  wrapExport (moduleExports, wrapper) {
    return shimmer.wrap(moduleExports, wrapper)
  }

  unwrapExport (moduleExports) {
    return shimmer.unwrap(moduleExports)
  }

  load (plugin, meta) {
    if (!this._enabled) return

    const instrumentations = [].concat(plugin)
    const enabled = meta.config.enabled !== false

    metrics.boolean(`datadog.tracer.node.plugin.enabled.by.name`, enabled, `name:${meta.name}`)

    try {
      instrumentations
        .forEach(instrumentation => {
          this._loader.load(instrumentation, meta.config)
        })
    } catch (e) {
      log.error(e)
      this.unload(plugin)
      log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)

      metrics.increment(`datadog.tracer.node.plugin.errors`, true)
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

      metrics.boolean(`datadog.tracer.node.plugin.enabled.by.name`, false, `name:${meta.name}`)
    }
  }

  patch (instrumentation, moduleExports, config) {
    let instrumented = this._instrumented.get(instrumentation)

    if (!instrumented) {
      this._instrumented.set(instrumentation, instrumented = new Set())
    }

    if (!instrumented.has(moduleExports)) {
      try {
        moduleExports = instrumentation.patch.call(this, moduleExports, this._tracer._tracer, config) || moduleExports
        return moduleExports
      } finally {
        // add even on error since `unpatch` will take care of removing it.
        instrumented.add(moduleExports)
      }
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
