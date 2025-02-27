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
const { getInstrumentation } = require('./helpers/load-inst')

const latestVersions = require('../../../datadog-instrumentations/src/helpers/latests.json').latests

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
    Object.keys(schemaDefinitions).forEach(versionName => {
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
        .use(traces => {
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

function isVersionInRange (version, latestVersion) {
  if (!latestVersion) return true
  try {
    return semver.lte(version, latestVersion)
  } catch (e) {
    return true // Safety fallback for invalid semver strings
  }
}

function withVersions (plugin, modules, range, cb) {
  // Normalize plugin parameter to an array of instrumentation objects
  const instrumentations = typeof plugin === 'string'
    ? getInstrumentation(plugin)
    : [].concat(plugin)

  // Extract all plugin names from instrumentations
  const names = instrumentations.map(instrumentation => instrumentation.name)

  // Ensure modules is an array
  modules = [].concat(modules)

  // Add dependent instrumentations for external plugins
  names.forEach(name => {
    if (externals[name]) {
      [].concat(externals[name]).forEach(external => {
        instrumentations.push(external)
      })
    }
  })

  // Handle case where range is omitted
  if (!cb) {
    cb = range
    range = null
  }

  // Process each module
  modules.forEach(moduleName => {
    // Skip if not in the PACKAGE_NAMES env var filter (when specified)
    if (process.env.PACKAGE_NAMES) {
      const packages = process.env.PACKAGE_NAMES.split(',')
      if (!packages.includes(moduleName)) return
    }

    // Map to store unique versions to test
    const testVersions = new Map()

    // Collect versions to test from applicable instrumentations
    instrumentations
      .filter(instrumentation => instrumentation.name === moduleName)
      .forEach(instrumentation => {
        // Use version range from environment or from instrumentation
        const versions = process.env.PACKAGE_VERSION_RANGE
          ? [process.env.PACKAGE_VERSION_RANGE]
          : instrumentation.versions

        // Process each version/range that passes the RANGE filter (if set)
        versions
          .filter(version => !process.env.RANGE || semver.subset(version, process.env.RANGE))
          .forEach(version => {
            // Handle exact version specifications (not wildcards)
            if (version !== '*') {
              // Handle explicit minimum versions in ranges like ">=2.0.0"
              if (version.startsWith('>=')) {
                const minVersion = version.substring(2).trim()
                const parsedMinVersion = semver.valid(minVersion)
                  ? minVersion
                  : semver.coerce(minVersion).version
                testVersions.set(parsedMinVersion, { range: version, test: parsedMinVersion })
              } else {
                // For other version specs, coerce to a standard semver format
                const min = semver.coerce(version).version
                testVersions.set(min, { range: version, test: min })
              }
            }

            // Try to find the latest compatible version from latests.json
            if (latestVersions[moduleName] && !process.env.PACKAGE_VERSION_RANGE) {
              // For exact versions
              if (semver.valid(version)) {
                // Use specified version if it's newer than latest, otherwise use latest
                const testVersion = isVersionInRange(version, latestVersions[moduleName])
                  ? version
                  : latestVersions[moduleName]
                testVersions.set(testVersion, { range: version, test: testVersion })
              } else if (semver.validRange(version)) { // For version ranges
                // Find the highest version that satisfies the range
                const testVersion = semver.maxSatisfying([latestVersions[moduleName]], version)
                if (testVersion) {
                  testVersions.set(testVersion, { range: version, test: testVersion })
                }
              }
            } else if (latestVersions[moduleName]) { // When PACKAGE_VERSION_RANGE is specified
              const range = process.env.PACKAGE_VERSION_RANGE
              // Check if latest version satisfies the range, or find max version that does
              const testVersion = semver.satisfies(latestVersions[moduleName], range)
                ? latestVersions[moduleName]
                : semver.maxSatisfying([latestVersions[moduleName]], range)
              if (testVersion) {
                testVersions.set(testVersion, { range: version, test: testVersion })
              }
            } else { // Fallback method: try to load version from the filesystem
              try {
                // Try to dynamically require the version module
                const max = require(`../../../../versions/${moduleName}@${version}`).version()
                testVersions.set(max, { range: version, test: version })
              } catch (err) {
                // FIX ME: log
                // Try an alternate path with a coerced version string
                try {
                  const coercedVersion = semver.coerce(version).version
                  const max = require(`../../../../versions/${moduleName}@${coercedVersion}`).version()
                  testVersions.set(max, { range: version, test: coercedVersion })
                } catch (innerErr) {
                  // FIX ME: log
                }
              }
            }
          })
      })

    // Create test suites for each version
    Array.from(testVersions)
      // Filter by the specified range if provided
      .filter(v => !range || semver.satisfies(v[0], range))
      // Sort by semver to run tests in version order
      .sort((a, b) => semver.compare(a[0], b[0]))
      // Format the version objects
      .map(v => Object.assign({}, v[1], { version: v[0] }))
      .forEach(v => {
        // Resolve the path to the module's node_modules directory
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

          // Run the provided test callback with the version information
          cb(v.test, moduleName, v.version)

          after(() => {
            // Restore the original NODE_PATH
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
