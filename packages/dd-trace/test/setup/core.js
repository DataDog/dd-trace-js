'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const os = require('os')
const proxyquire = require('../proxyquire')
const semver = require('semver')
const platform = require('../../src/platform')
const node = require('../../src/platform/node')
const AsyncHooksScope = require('../../src/scope/async_hooks')
const agent = require('../plugins/agent')
const externals = require('../plugins/externals.json')

const asyncHooksScope = new AsyncHooksScope({
  trackAsyncScope: true
})

chai.use(sinonChai)
chai.use(require('../asserts/profile'))

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire
global.wrapIt = wrapIt
global.withVersions = withVersions

platform.use(node)

afterEach(() => {
  agent.reset()
  platform.metrics().stop()
})

function wrapIt () {
  const it = global.it
  const only = global.it.only

  function wrap (testFn) {
    return function (title, fn) {
      if (!fn) return testFn.apply(this, arguments)

      const length = fn.length

      fn = asyncHooksScope.bind(fn, null)

      if (length > 0) {
        return testFn.call(this, title, function (done) {
          done = asyncHooksScope.bind(done, null)

          return fn.call(this, done)
        })
      } else {
        return testFn.call(this, title, fn)
      }
    }
  }

  global.it = wrap(it)
  global.it.only = wrap(only)

  global.it.skip = it.skip
}

function withVersions (plugin, modules, range, cb) {
  const instrumentations = [].concat(plugin)
  const names = [].concat(plugin).map(instrumentation => instrumentation.name)

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
