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
const { getInstrumentation } = require('./helpers/load-inst')

global.withVersions = withVersions
global.withExports = withExports
global.withNamingSchema = withNamingSchema
global.withPeerService = withPeerService

const testedPlugins = agent.testedPlugins

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

    it('should compute peer service', done => {
      agent
        .assertSomeTraces(traces => {
          const span = traces[0][0]
          expect(span.meta).to.have.property('peer.service', typeof service === 'function' ? service() : service)
          expect(span.meta).to.have.property('_dd.peer.service.source', serviceSource)
        })
        .then(done)
        .catch(done)

      spanGenerationFn(done)
    })
  })
}

function withVersions (plugin, modules, range, cb) {
  const instrumentations = typeof plugin === 'string' ? getInstrumentation(plugin) : [].concat(plugin)
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
    if (process.env.PACKAGE_NAMES) {
      const packages = process.env.PACKAGE_NAMES.split(',')

      if (!packages.includes(moduleName)) return
    }

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
            if (version !== '*') {
              const min = semver.coerce(version).version

              testVersions.set(min, { range: version, test: min })
            }

            const max = require(`../../../../versions/${moduleName}@${version}`).version()

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

        describe(`with ${moduleName} ${v.range} (${v.version})`, () => {
          let nodePath

          before(() => {
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

          cb(v.test, moduleName, v.version)

          after(() => {
            process.env.NODE_PATH = nodePath
            require('module').Module._initPaths()
          })
        })
      })
  })
}

function withExports (moduleName, version, exportNames, versionRange, fn) {
  const getExport = () => require(`../../../../versions/${moduleName}@${version}`).get()
  describe('with the default export', () => fn(getExport))

  if (typeof versionRange === 'function') {
    fn = versionRange
    versionRange = '*'
  }

  if (!semver.intersects(version, versionRange)) return

  for (const exportName of exportNames) {
    const getExport = () => require(`../../../../versions/${moduleName}@${version}`).get()[exportName]
    describe(`with exports.${exportName}`, () => fn(getExport))
  }
}

exports.mochaHooks = {
  afterEach () {
    agent.reset()
    runtimeMetrics.stop()
    storage('legacy').enterWith(undefined)
  }
}
