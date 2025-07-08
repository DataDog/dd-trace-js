'use strict'

require('./core')

const assert = require('node:assert')
const util = require('node:util')
const { platform } = require('node:os')
const path = require('node:path')
const semver = require('semver')
const externals = require('../plugins/externals.json')
const runtimeMetrics = require('../../src/runtime_metrics')
const agent = require('../plugins/agent')
const Nomenclature = require('../../src/service-naming')
const { storage } = require('../../../datadog-core')
const { getInstrumentation } = require('./helpers/load-inst')

const NODE_PATH_SEP = platform() === 'win32' ? ';' : ':'

// TODO: Remove global
global.withVersions = withVersions

exports.withVersions = withVersions
exports.withExports = withExports
exports.withNamingSchema = withNamingSchema
exports.withPeerService = withPeerService

const testedPlugins = agent.testedPlugins

function withNamingSchema (
  spanProducerFn,
  expected,
  opts = {}
) {
  const {
    hooks = (version, defaultToGlobalService) => {},
    desc = '',
    selectSpan = (traces) => traces[0][0],
  } = opts
  let fullConfig

  const testTitle = 'service and operation naming' + (desc !== '' ? ` (${desc})` : '')

  describe(testTitle, () => {
    ['v0', 'v1'].forEach(versionName => {
      describe(`in version ${versionName}`, () => {
        before(() => {
          fullConfig = Nomenclature.config
          Nomenclature.configure({
            spanAttributeSchema: versionName,
            spanRemoveIntegrationFromService: false,
            service: fullConfig.service // Hack: only way to retrieve the test agent configuration
          })
        })

        after(() => {
          Nomenclature.configure(fullConfig)
        })

        hooks(versionName, false)

        const { opName, serviceName } = expected[versionName]

        it('should conform to the naming schema', function () {
          this.timeout(10000)
          return new Promise((resolve, reject) => {
            agent
              .assertSomeTraces(traces => {
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

    describe('service naming short-circuit in v0', () => {
      before(() => {
        fullConfig = Nomenclature.config
        Nomenclature.configure({
          spanAttributeSchema: 'v0',
          service: fullConfig.service,
          spanRemoveIntegrationFromService: true
        })
      })

      after(() => {
        Nomenclature.configure(fullConfig)
      })

      hooks('v0', true)

      const { serviceName } = expected.v1

      it('should pass service name through', done => {
        agent
          .assertSomeTraces(traces => {
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
  describe('peer service computation' + (opts.desc ? ` ${opts.desc}` : ''), () => {
    let computePeerServiceSpy

    beforeEach(() => {
      const plugin = tracer()._pluginManager._pluginsByName[pluginName]
      computePeerServiceSpy = sinon.stub(plugin._tracerConfig, 'spanComputePeerService').value(true)
    })

    afterEach(() => {
      computePeerServiceSpy.restore()
    })

    it('should compute peer service', async () => {
      const useCallback = spanGenerationFn.length === 1
      const spanGenerationPromise = useCallback
        ? new Promise((resolve, reject) => {
          const result = spanGenerationFn((err) => err ? reject(err) : resolve())
          // Some callback based methods are a mixture of callback and promise,
          // depending on the module version. Await the promises as well.
          if (util.types.isPromise(result)) {
            result.then?.(resolve, reject)
          }
        })
        : spanGenerationFn()

      assert.ok(
        typeof spanGenerationPromise?.then === 'function',
        'spanGenerationFn should return a promise in case no callback is defined. Received: ' +
        util.inspect(spanGenerationPromise, { depth: 1 })
      )

      await Promise.all([
        agent.assertSomeTraces(traces => {
          const span = traces[0][0]
          expect(span.meta).to.have.property('peer.service', typeof service === 'function' ? service() : service)
          expect(span.meta).to.have.property('_dd.peer.service.source', serviceSource)
        }),
        spanGenerationPromise
      ])
    })
  })
}

/**
 * @overload
 * @param {string|Plugin} plugin - The name of the plugin to test, e.g. 'fastify', or the exports object of an already
 *     loaded plugin
 * @param {string|string[]} modules - The name(s) of the module(s) to test, e.g. 'fastify' or ['fastify', 'middie']
 * @param {withVersionsCallback} cb - The callback function to call with the test case data
 * @returns {void}
 *
 * @overload
 * @param {string|Plugin} plugin - The name of the plugin to test, e.g. 'fastify', or the exports object of an already
 *     loaded plugin
 * @param {string|string[]} modules - The name(s) of the module(s) to test, e.g. 'fastify' or ['fastify', 'middie']
 * @param {string} range - The specific version or range of versions to test, e.g. '>=3' or '3.1.2'
 * @param {withVersionsCallback} cb - The callback function to call with the test case data
 * @returns {void}
 *
 * @typedef {object} Plugin
 * @property {string} name
 * @property {string} version
 *
 * @callback withVersionsCallback
 * @param {string} versionKey - The version string used in the module path
 * @param {string} moduleName - The name of the module being tested
 * @param {string} resolvedVersion - The specific version of the module being tested
 */
function withVersions (plugin, modules, range, cb) {
  if (typeof range === 'function') {
    cb = range
    range = undefined
  }

  const instrumentations = typeof plugin === 'string' ? getInstrumentation(plugin) : [plugin]
  const names = new Set(instrumentations.map(instrumentation => instrumentation.name))

  for (const name of names) {
    if (!externals[name]) continue
    for (const external of externals[name]) {
      instrumentations.push(external)
    }
  }

  for (const moduleName of Array.isArray(modules) ? modules : [modules]) {
    if (process.env.PACKAGE_NAMES) {
      const packages = process.env.PACKAGE_NAMES.split(',')

      if (!packages.includes(moduleName)) return
    }

    /** @type {Map<string, {versionRange: string, versionKey: string, resolvedVersion: string}>} */
    const testVersions = new Map()

    for (const instrumentation of instrumentations) {
      if (instrumentation.name !== moduleName) continue

      const versions = process.env.PACKAGE_VERSION_RANGE
        ? [process.env.PACKAGE_VERSION_RANGE]
        : instrumentation.versions

      for (const version of versions) {
        if (process.env.RANGE && !semver.subset(version, process.env.RANGE)) continue
        if (version !== '*') {
          const result = semver.coerce(version)
          if (!result) throw new Error(`Invalid version: ${version}`)
          const min = result.version
          testVersions.set(min, { versionRange: version, versionKey: min, resolvedVersion: min })
        }

        const max = require(getModulePath(moduleName, version)).version()
        testVersions.set(max, { versionRange: version, versionKey: version, resolvedVersion: max })
      }
    }

    const testCases = Array.from(testVersions.values())
      .filter(({ resolvedVersion }) => !range || semver.satisfies(resolvedVersion, range))
      .sort(({ resolvedVersion }) => resolvedVersion.localeCompare(resolvedVersion))

    for (const testCase of testCases) {
      const absBasePath = path.resolve(__dirname, getModulePath(moduleName, testCase.versionKey))
      const absNodeModulesPath = `${absBasePath}/node_modules`

      describe(`with ${moduleName} ${testCase.versionRange} (${testCase.resolvedVersion})`, () => {
        let nodePath

        before(() => {
          // set plugin name and version to later report to test agent regarding tested integrations and their tested
          // range of versions
          const lastPlugin = testedPlugins.at(-1)
          if (
            !lastPlugin || lastPlugin.pluginName !== plugin || lastPlugin.pluginVersion !== testCase.resolvedVersion
          ) {
            testedPlugins.push({ pluginName: plugin, pluginVersion: testCase.resolvedVersion })
          }

          nodePath = process.env.NODE_PATH
          process.env.NODE_PATH += `${NODE_PATH_SEP}${absNodeModulesPath}`

          require('module').Module._initPaths()
        })

        cb(testCase.versionKey, moduleName, testCase.resolvedVersion)

        after(() => {
          process.env.NODE_PATH = nodePath
          require('module').Module._initPaths()
        })
      })
    }
  }
}

/**
 * @overload
 * @param {string} moduleName - The name of the module being tested
 * @param {string} version - The specific version of the module being tested
 * @param {string[]} exportNames - The names of the module exports to be tested (the default export will always be
 *     tested)
 * @param {withExportsCallback} cb
 *
 * @overload
 * @param {string} moduleName - The name of the module being tested
 * @param {string} version - The specific version of the module being tested
 * @param {string[]} exportNames - The names of the module exports to be tested (the default export will always be
 *     tested)
 * @param {string} versionRange - The version range in which the given version should reside. If not within this range,
 *     only the default export will be tested.
 * @param {withExportsCallback} cb
 *
 * @callback withExportsCallback
 * @param {function} getExport - A function that returns the module export to test
 */
function withExports (moduleName, version, exportNames, versionRange, cb) {
  if (typeof versionRange === 'function') {
    cb = versionRange
    versionRange = '*'
  }

  const getExport = () => require(getModulePath(moduleName, version)).get()
  describe('with the default export', () => cb(getExport))

  if (!semver.intersects(version, versionRange)) return

  for (const exportName of exportNames) {
    const getExport = () => require(getModulePath(moduleName, version)).get()[exportName]
    describe(`with exports.${exportName}`, () => cb(getExport))
  }
}

function getModulePath (moduleName, version) {
  return `../../../../versions/${moduleName}@${version}`
}

exports.mochaHooks = {
  afterEach () {
    agent.reset()
    runtimeMetrics.stop()
    storage('legacy').enterWith(undefined)
  }
}
