'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const os = require('os')
const path = require('path')
const proxyquire = require('../proxyquire')
const semver = require('semver')
const metrics = require('../../src/metrics')
const agent = require('../plugins/agent')
const externals = require('../plugins/externals.json')
const { storage } = require('../../../datadog-core')

chai.use(sinonChai)
chai.use(require('../asserts/profile'))

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire
global.withVersions = withVersions
global.withExports = withExports

process.env.DD_TRACE_TELEMETRY_ENABLED = 'false'

afterEach(() => {
  agent.reset()
  metrics.stop()
})

afterEach(() => {
  storage.enterWith(undefined)
})

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

function removeVersions (instrumentations, external) {
  let idx = 0
  while (idx < instrumentations.length) {
    const inst = instrumentations[idx]
    if (JSON.stringify(inst.versions) === JSON.stringify(external.versions)) {
      instrumentations.splice(idx, 1)
    } else {
      idx++
    }
  }
}

function withVersions (plugin, modules, range, cb) {
  const instrumentations = typeof plugin === 'string' ? loadInst(plugin) : [].concat(plugin)
  const names = instrumentations.map(instrumentation => instrumentation.name)

  modules = [].concat(modules)

  names.forEach(name => {
    if (externals[name]) {
      [].concat(externals[name]).forEach(external => {
        const { nodeVersions } = external
        let satisfies = true
        if (nodeVersions) {
          satisfies = false
          for (const version of nodeVersions) {
            if (semver.satisfies(process.version, version)) {
              satisfies = true
              break
            }
          }
        }

        if (satisfies) {
          instrumentations.push(external)
        } else {
          // remove all versions with that don't satisfy node version based on externals
          removeVersions(instrumentations, external)
        }
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
          .forEach(version => {
            const min = semver.coerce(version).version
            const max = require(`../../../../versions/${moduleName}@${version}`).version()
            if (!instrumentation.ignoreMinVersion) testVersions.set(min, { range: version, test: min })
            testVersions.set(max, { range: version, test: version })
          })
      })

    Array.from(testVersions)
      .filter(v => !range || semver.satisfies(v[0], range))
      .sort(v => v[0].localeCompare(v[0]))
      .map(v => Object.assign({}, v[1], { version: v[0] }))
      .forEach(v => {
        const versionPath = `${__dirname}/../../../../versions/${moduleName}@${v.test}/node_modules`

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
