'use strict'

require('./core')

const os = require('os')
const path = require('path')
const semver = require('semver')
const externals = require('../plugins/externals.json')
const runtimeMetrics = require('../../src/runtime_metrics')
const agent = require('../plugins/agent')
const Nomenclature = require('../../src/service-naming')
const { storage } = require('../../../datadog-core')
const { schemaDefinitions } = require('../../src/service-naming/schemas')
const { after, afterEach, before, beforeEach, describe, it } = require('node:test')
const { NODE_MAJOR, NODE_MINOR } = require('../../../../version')
const { AsyncLocalStorage } = require('async_hooks')

const hookStorage = new AsyncLocalStorage()
const timeoutStorage = new AsyncLocalStorage()

global.after = wrapIt(after, true)
global.afterEach = wrapEach(afterEach)
global.before = wrapIt(before, true)
global.beforeEach = wrapEach(beforeEach)
global.describe = wrapDescribe(describe)
global.describe.only = wrapDescribe(describe.only)
global.describe.skip = describe.skip
global.describe.todo = describe.todo
global.context = global.describe
global.it = wrapIt(it)
global.it.only = wrapIt(it.only)
global.it.skip = it.skip
global.it.todo = it.todo
global.withVersions = withVersions
global.withExports = withExports
global.withNamingSchema = withNamingSchema
global.withPeerService = withPeerService

function wrapDescribe (describe) {
  const wrapper = function (...args) {
    const hookStore = hookStorage.getStore()
    const timeout = getTimeout(args)

    if (NODE_MAJOR < 20 || (NODE_MAJOR === 20 && NODE_MINOR < 13)) {
      const fn = args[args.length - 1]
      const parentHooks = hookStore || []

      args[args.length - 1] = function (...args) {
        parentHooks.forEach(hook => hook())

        return timeoutStorage.run(timeout, () => {
          return hookStorage.run([...parentHooks], () => {
            return fn.apply(this, args)
          })
        })
      }
    }

    return describe.apply(this, args)
  }

  return wrapper
}

function wrapIt (it, optionsAfterFn = false) {
  const wrapper = function (...args) {
    const index = optionsAfterFn ? 0 : args.length - 1
    const fn = args[index]

    addTimeout(args, optionsAfterFn)

    if (fn.length > 0) {
      args[index] = function (t, ddone) {
        if (ddone) return fn.call(this, ddone)

        return new Promise((resolve, reject) => {
          return fn.call(this, (e) => {
            if (e instanceof Error) {
              reject(e)
            } else {
              resolve()
            }
          })
        })
      }
    }

    return it.apply(this, args)
  }

  return wrapper
}

function wrapEach (each) {
  if (NODE_MAJOR > 20 || (NODE_MAJOR === 20 && NODE_MINOR >= 13)) return wrapIt(each, true)

  const wrapper = wrapIt(function (...args) {
    const hooks = hookStorage.getStore()

    hooks.push(() => each.apply(this, args))

    return each.apply(this, args)
  }, true)

  return wrapper
}

function getTimeout (args, optionsAfterFn = false) {
  const index = optionsAfterFn ? args.length - 1 : args.length - 2

  return typeof args[index] === 'object' && args[index].timeout
}

function addTimeout (args, optionsAfterFn = false) {
  const timeoutStore = timeoutStorage.getStore()
  const options = { timeout: timeoutStore || 5000 }
  const index = optionsAfterFn ? args.length - 1 : args.length - 2
  const spliceIndex = index + 1

  if (typeof args[index] === 'object') {
    args[index] = Object.assign(options, args[index])
  } else {
    args.splice(spliceIndex, 0, options)
  }

  return options.timeout
}

const testedPlugins = agent.testedPlugins

function loadInst (plugin) {
  const instrumentations = []

  try {
    loadInstFile(`${plugin}/server.js`, instrumentations)
    loadInstFile(`${plugin}/client.js`, instrumentations)
  } catch (e) {
    try {
      loadInstFile(`${plugin}/main.js`, instrumentations)
    } catch (e) {
      loadInstFile(`${plugin}.js`, instrumentations)
    }
  }

  return instrumentations
}

function loadInstFile (file, instrumentations) {
  const instrument = {
    addHook (instrumentation) {
      instrumentations.push(instrumentation)
    }
  }

  const instPath = path.join(__dirname, `../../../datadog-instrumentations/src/${file}`)

  proxyquire.noPreserveCache()(instPath, {
    './helpers/instrument': instrument,
    '../helpers/instrument': instrument
  })
}

function withNamingSchema (
  spanProducerFn,
  expected,
  opts = {}
) {
  const {
    hooks = (version, defaultToGlobalService) => {},
    desc = '',
    selectSpan = (traces) => traces[0][0]
  } = opts
  let fullConfig

  const testTitle = 'service and operation naming' + (desc !== '' ? ` (${desc})` : '')

  global.describe(testTitle, () => {
    Object.keys(schemaDefinitions).forEach(versionName => {
      global.describe(`in version ${versionName}`, () => {
        global.before(() => {
          fullConfig = Nomenclature.config
          Nomenclature.configure({
            spanAttributeSchema: versionName,
            spanRemoveIntegrationFromService: false,
            service: fullConfig.service // Hack: only way to retrieve the test agent configuration
          })
        })

        global.after(() => {
          Nomenclature.configure(fullConfig)
        })

        hooks(versionName, false)

        const { opName, serviceName } = expected[versionName]

        global.it('should conform to the naming schema', { timeout: 10000 }, function () {
          return new Promise((resolve, reject) => {
            agent
              .use(traces => {
                const span = selectSpan(traces)
                const expectedOpName = typeof opName === 'function'
                  ? opName()
                  : opName
                const expectedServiceName = typeof serviceName === 'function'
                  ? serviceName()
                  : serviceName

                expect(span).to.have.property('name', expectedOpName)
                expect(span).to.have.property('service', expectedServiceName)
              })
              .then(resolve)
              .catch(reject)
            spanProducerFn(reject)
          })
        })
      })
    })

    global.describe('service naming short-circuit in v0', () => {
      before(() => {
        fullConfig = Nomenclature.config
        Nomenclature.configure({
          spanAttributeSchema: 'v0',
          service: fullConfig.service,
          spanRemoveIntegrationFromService: true
        })
      })

      global.after(() => {
        Nomenclature.configure(fullConfig)
      })

      hooks('v0', true)

      const { serviceName } = expected.v1

      global.it('should pass service name through', done => {
        agent
          .use(traces => {
            const span = traces[0][0]
            const expectedServiceName = typeof serviceName === 'function'
              ? serviceName()
              : serviceName
            expect(span).to.have.property('service', expectedServiceName)
          })
          .then(done)
          .catch(done)

        spanProducerFn(done)
      })
    })
  })
}

function withPeerService (tracer, pluginName, spanGenerationFn, service, serviceSource, opts = {}) {
  global.describe('peer service computation' + (opts.desc ? ` ${opts.desc}` : ''), () => {
    let computePeerServiceSpy

    global.beforeEach(() => {
      const plugin = tracer()._pluginManager._pluginsByName[pluginName]
      computePeerServiceSpy = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    global.afterEach(() => {
      computePeerServiceSpy.restore()
    })

    global.it('should compute peer service', done => {
      agent
        .use(traces => {
          const span = traces[0][0]
          expect(span.meta).to.have.property('peer.service', service)
          expect(span.meta).to.have.property('_dd.peer.service.source', serviceSource)
        })
        .then(done)
        .catch(done)

      spanGenerationFn(done)
    })
  })
}

function withVersions (plugin, modules, range, cb) {
  const instrumentations = typeof plugin === 'string' ? loadInst(plugin) : [].concat(plugin)
  const names = instrumentations.map(instrumentation => instrumentation.name)

  modules = [].concat(modules)

  names.forEach(name => {
    if (externals[name]) {
      [].concat(externals[name]).forEach(external => {
        instrumentations.push(external)
      })
    }
  })

  if (!cb) {
    cb = range
    range = null
  }

  modules.forEach(moduleName => {
    const testVersions = new Map()

    instrumentations
      .filter(instrumentation => instrumentation.name === moduleName)
      .forEach(instrumentation => {
        const versions = process.env.PACKAGE_VERSION_RANGE
          ? [process.env.PACKAGE_VERSION_RANGE]
          : instrumentation.versions
        versions
          .filter(version => !process.env.RANGE || semver.subset(version, process.env.RANGE))
          .forEach(version => {
            const min = semver.coerce(version).version
            const max = require(`../../../../versions/${moduleName}@${version}`).version()

            testVersions.set(min, { range: version, test: min })
            testVersions.set(max, { range: version, test: version })
          })
      })

    Array.from(testVersions)
      .filter(v => !range || semver.satisfies(v[0], range))
      .sort(v => v[0].localeCompare(v[0]))
      .map(v => Object.assign({}, v[1], { version: v[0] }))
      .forEach(v => {
        const versionPath = path.resolve(
          __dirname, '../../../../versions/',
          `${moduleName}@${v.test}/node_modules`
        )

        global.describe(`with ${moduleName} ${v.range} (${v.version})`, () => {
          let nodePath

          global.before(() => {
            // set plugin name and version to later report to test agent regarding tested integrations and
            // their tested range of versions
            const lastPlugin = testedPlugins[testedPlugins.length - 1]
            if (!lastPlugin || lastPlugin.pluginName !== plugin || lastPlugin.pluginVersion !== v.version) {
              testedPlugins.push({ pluginName: plugin, pluginVersion: v.version })
            }

            nodePath = process.env.NODE_PATH
            process.env.NODE_PATH = [process.env.NODE_PATH, versionPath]
              .filter(x => x && x !== 'undefined')
              .join(os.platform() === 'win32' ? ';' : ':')

            require('module').Module._initPaths()
          })

          cb(v.test, moduleName)

          global.after(() => {
            process.env.NODE_PATH = nodePath
            require('module').Module._initPaths()
          })
        })
      })
  })
}

function withExports (moduleName, version, exportNames, versionRange, fn) {
  const getExport = () => require(`../../../../versions/${moduleName}@${version}`).get()
  global.describe('with the default export', () => fn(getExport))

  if (typeof versionRange === 'function') {
    fn = versionRange
    versionRange = '*'
  }

  if (!semver.intersects(version, versionRange)) return

  for (const exportName of exportNames) {
    const getExport = () => require(`../../../../versions/${moduleName}@${version}`).get()[exportName]
    global.describe(`with exports.${exportName}`, () => fn(getExport))
  }
}

exports.mochaHooks = {
  afterEach () {
    agent.reset()
    runtimeMetrics.stop()
    storage.enterWith(undefined)
  }
}

afterEach(() => {
  agent.reset()
  runtimeMetrics.stop()
  storage.enterWith(undefined)
})
