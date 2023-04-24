'use strict'

require('./core')

const os = require('os')
const path = require('path')
const semver = require('semver')
const externals = require('../plugins/externals.json')
const slackReport = require('./slack-report')
const metrics = require('../../src/metrics')
const agent = require('../plugins/agent')
const { storage } = require('../../../datadog-core')

global.withVersions = withVersions
global.withExports = withExports

const packageVersionFailures = Object.create({})

function loadInst (plugin) {
  const instrumentations = []

  try {
    loadInstFile(`${plugin}/server.js`, instrumentations)
    loadInstFile(`${plugin}/client.js`, instrumentations)
  } catch (e) {
    loadInstFile(`${plugin}.js`, instrumentations)
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
        instrumentation.versions
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
        const versionPath = `${__dirname}/../../../../versions/${moduleName}@${v.test}/node_modules`

        // afterEach contains currentTest data
        // after doesn't contain test data nor know if any tests passed/failed
        let moduleVersionDidFail = false

        describe(`with ${moduleName} ${v.range} (${v.version})`, () => {
          let nodePath

          before(() => {
            nodePath = process.env.NODE_PATH
            process.env.NODE_PATH = [process.env.NODE_PATH, versionPath]
              .filter(x => x && x !== 'undefined')
              .join(os.platform() === 'win32' ? ';' : ':')

            require('module').Module._initPaths()
          })

          cb(v.test, moduleName)

          afterEach(function () {
            if (this.currentTest.state === 'failed') {
              moduleVersionDidFail = true
            }
          })

          after(() => {
            if (moduleVersionDidFail) {
              if (!packageVersionFailures[moduleName]) {
                packageVersionFailures[moduleName] = new Set()
              }

              packageVersionFailures[moduleName].add(v.version)
            }

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
  // TODO: Figure out how to do this with tap too.
  async afterAll () {
    await slackReport(packageVersionFailures)
  },

  afterEach () {
    agent.reset()
    metrics.stop()
    storage.enterWith(undefined)
  }
}
