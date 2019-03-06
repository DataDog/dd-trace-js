'use strict'

const semver = require('semver')
const hook = require('require-in-the-middle')
const parse = require('module-details-from-path')
const path = require('path')
const shimmer = require('shimmer')
const uniq = require('lodash.uniq')
const log = require('./log')

const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

shimmer({ logger: () => {} })

class Instrumenter {
  constructor (tracer) {
    this._tracer = tracer
    this._enabled = false
    this._names = new Set()
    this._plugins = new Map()
    this._instrumented = new Map()
  }

  use (name, config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }

    config = config || {}

    try {
      this._set(require(`./plugins/${name}`), { name, config })
    } catch (e) {
      log.debug(`Could not find a plugin named "${name}".`)
    }

    this.reload()
  }

  patch (config) {
    config = config || {}

    if (config.plugins !== false) {
      const plugins = require('./plugins')

      Object.keys(plugins)
        .forEach(name => {
          this._plugins.has(plugins[name]) || this._set(plugins[name], { name, config: {} })
        })
    }

    this.reload()
  }

  unpatch () {
    this._instrumented.forEach((moduleExports, instrumentation) => {
      this._unpatch(instrumentation)
    })

    this._plugins.clear()
  }

  reload () {
    if (!this._enabled) return

    const instrumentations = Array.from(this._plugins.keys())
      .reduce((prev, current) => prev.concat(current), [])

    const instrumentedModules = uniq(instrumentations
      .map(instrumentation => instrumentation.name))

    this._names = new Set(instrumentations
      .map(instrumentation => filename(instrumentation)))

    hook(instrumentedModules, { internals: true }, this.hookModule.bind(this))
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

  hookModule (moduleExports, moduleName, moduleBaseDir) {
    moduleName = moduleName.replace(pathSepExpr, '/')

    if (!this._names.has(moduleName)) {
      return moduleExports
    }

    if (moduleBaseDir) {
      moduleBaseDir = moduleBaseDir.replace(pathSepExpr, '/')
    }

    const moduleVersion = getVersion(moduleBaseDir)

    Array.from(this._plugins.keys())
      .filter(plugin => [].concat(plugin).some(instrumentation =>
        filename(instrumentation) === moduleName && matchVersion(moduleVersion, instrumentation.versions)
      ))
      .forEach(plugin => this._validate(plugin, moduleBaseDir, moduleVersion))

    this._plugins
      .forEach((meta, plugin) => {
        try {
          [].concat(plugin)
            .filter(instrumentation => moduleName === filename(instrumentation))
            .filter(instrumentation => matchVersion(moduleVersion, instrumentation.versions))
            .forEach(instrumentation => {
              const config = this._plugins.get(plugin).config

              if (config.enabled !== false) {
                this._patch(instrumentation, moduleExports, config)
              }
            })
        } catch (e) {
          log.error(e)
          this._fail(plugin)
          log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)
        }
      })

    return moduleExports
  }

  enable () {
    this._enabled = true
  }

  _set (plugin, meta) {
    const analytics = {}

    if (typeof this._tracer._tracer._analytics === 'boolean') {
      analytics.enabled = this._tracer._tracer._analytics
    }

    meta.config.analytics = Object.assign(analytics, normalizeAnalyticsConfig(meta.config.analytics))

    this._plugins.set(plugin, meta)
    this._load(plugin, meta)
  }

  _validate (plugin, moduleBaseDir, moduleVersion) {
    const meta = this._plugins.get(plugin)
    const instrumentations = [].concat(plugin)

    for (let i = 0; i < instrumentations.length; i++) {
      if (instrumentations[i].versions && !matchVersion(moduleVersion, instrumentations[i].versions)) continue
      if (instrumentations[i].file && !exists(moduleBaseDir, instrumentations[i].file)) {
        this._fail(plugin)
        log.debug([
          `Plugin "${meta.name}" requires "${instrumentations[i].file}" which was not found.`,
          `The plugin was disabled.`
        ].join(' '))
        break
      }
    }
  }

  _fail (plugin) {
    [].concat(plugin)
      .forEach(instrumentation => {
        this._unpatch(instrumentation)
        this._instrumented.delete(instrumentation)
      })

    this._plugins.delete(plugin)
  }

  _patch (instrumentation, moduleExports, config) {
    let instrumented = this._instrumented.get(instrumentation)

    if (!instrumented) {
      this._instrumented.set(instrumentation, instrumented = new Set())
    }

    if (!instrumented.has(moduleExports)) {
      instrumented.add(moduleExports)
      instrumentation.patch.call(this, moduleExports, this._tracer._tracer, config)
    }
  }

  _unpatch (instrumentation) {
    const instrumented = this._instrumented.get(instrumentation)

    if (instrumented) {
      instrumented.forEach(moduleExports => {
        try {
          instrumentation.unpatch.call(this, moduleExports)
        } catch (e) {
          log.error(e)
        }
      })
    }
  }

  _load (plugin, meta) {
    if (this._enabled) {
      const instrumentations = [].concat(plugin)

      try {
        instrumentations
          .forEach(instrumentation => {
            getModules(instrumentation).forEach(nodule => {
              this._patch(instrumentation, nodule, meta.config)
            })
          })
      } catch (e) {
        log.error(e)
        this._fail(plugin)
        log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)
      }
    }
  }
}

function normalizeAnalyticsConfig (config) {
  switch (typeof config) {
    case 'boolean':
      return { enabled: config }
    case 'object':
      if (config) return config
    default: // eslint-disable-line no-fallthrough
      return {}
  }
}

function getModules (instrumentation) {
  const modules = []
  const ids = Object.keys(require.cache)

  let pkg

  for (let i = 0, l = ids.length; i < l; i++) {
    const id = ids[i].replace(pathSepExpr, '/')

    if (!id.includes(`/node_modules/${instrumentation.name}/`)) continue

    if (instrumentation.file) {
      if (!id.endsWith(`/node_modules/${filename(instrumentation)}`)) continue

      const basedir = getBasedir(ids[i])

      pkg = require(`${basedir}/package.json`)
    } else {
      const basedir = getBasedir(ids[i])

      pkg = require(`${basedir}/package.json`)

      if (!id.endsWith(`/node_modules/${instrumentation.name}/${pkg.main}`)) continue
    }

    if (!matchVersion(pkg.version, instrumentation.versions)) continue

    modules.push(require.cache[ids[i]].exports)
  }

  return modules
}

function getBasedir (id) {
  return parse(id).basedir.replace(pathSepExpr, '/')
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(version, range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    const packageJSON = `${moduleBaseDir}/package.json`
    return require(packageJSON).version
  }
}

function filename (plugin) {
  return [plugin.name, plugin.file].filter(val => val).join('/')
}

function exists (basedir, file) {
  try {
    require.resolve(`${basedir}/${file}`)
    return true
  } catch (e) {
    return false
  }
}

module.exports = Instrumenter
