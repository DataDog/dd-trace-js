'use strict'

const sinon = require('sinon')
const chai = require('chai')
const sinonChai = require('sinon-chai')
const proxyquire = require('../proxyquire')
const nock = require('nock')
const semver = require('semver')
const platform = require('../../src/platform')
const node = require('../../src/platform/node')
const ScopeManager = require('../../src/scope/scope_manager')
const agent = require('../plugins/agent')
const externals = require('../plugins/externals.json')

const scopeManager = new ScopeManager()

chai.use(sinonChai)

global.sinon = sinon
global.expect = chai.expect
global.proxyquire = proxyquire
global.nock = nock
global.wrapIt = wrapIt
global.withVersions = withVersions

platform.use(node)

after(() => {
  scopeManager._disable()
})

afterEach(() => {
  agent.reset()
})

function withoutScope (fn) {
  return function () {
    let active

    while ((active = scopeManager.active())) {
      active.close()
    }

    return fn.apply(this, arguments)
  }
}

function wrapIt () {
  const it = global.it

  global.it = function (title, fn) {
    if (!fn) {
      return it.apply(this, arguments)
    }

    if (fn.length > 0) {
      return it.call(this, title, function (done) {
        arguments[0] = withoutScope(agent.wrap(done))

        return fn.apply(this, arguments)
      })
    } else {
      return it.call(this, title, function () {
        const result = fn.apply(this, arguments)

        if (result && result.then) {
          return result
            .then(withoutScope(res => res))
            .catch(withoutScope(err => Promise.reject(err)))
            .then(() => agent.promise())
        }

        return agent.promise()
          .then(() => result)
      })
    }
  }
}

function withVersions (plugin, moduleName, range, cb) {
  const instrumentations = [].concat(plugin)
  const testVersions = new Map()

  if (externals[moduleName]) {
    [].concat(externals[moduleName]).forEach(external => {
      instrumentations.push(external)
    })
  }

  if (!cb) {
    cb = range
    range = null
  }

  instrumentations
    .filter(instrumentation => instrumentation.name === moduleName)
    .forEach(instrumentation => {
      instrumentation.versions
        .forEach(version => {
          try {
            const min = semver.coerce(version).version
            require(`../../versions/${moduleName}@${min}`).get()
            testVersions.set(min, { range: version, test: min })
          } catch (e) {
            // skip unsupported version
          }

          agent.wipe()

          try {
            const max = require(`../../versions/${moduleName}@${version}`).version()
            require(`../../versions/${moduleName}@${version}`).get()
            testVersions.set(max, { range: version, test: version })
          } catch (e) {
            // skip unsupported version
          }

          agent.wipe()
        })
    })

  Array.from(testVersions)
    .filter(v => !range || semver.satisfies(v[0], range))
    .sort(v => v[0].localeCompare(v[0]))
    .map(v => Object.assign({}, v[1], { version: v[0] }))
    .forEach(v => {
      describe(`with ${moduleName} ${v.range} (${v.version})`, () => cb(v.test))
    })

  agent.wipe()
}
