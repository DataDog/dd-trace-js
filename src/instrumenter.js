'use strict'

const semver = require('semver')
const hook = require('require-in-the-middle')
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
              this._instrumented.set(instrumentation, moduleExports)
              instrumentation.patch.call(this, moduleExports, this._tracer._tracer, this._plugins.get(plugin).config)
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
    this._plugins.set(plugin, Object.assign({ config: {} }, meta))
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

  _unpatch (instrumentation) {
    try {
      instrumentation.unpatch.call(this, this._instrumented.get(instrumentation))
    } catch (e) {
      log.error(e)
    }
  }
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
