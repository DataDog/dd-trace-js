'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { getCallSites } = require('../../../dd-trace/src/plugins/util/stacktrace')
const { DD_MAJOR } = require('../../../../version')
const { testToStartLine } = require('./utils')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const patched = new WeakSet()

/**
 * Registers every Mocha package view that can expose the constructor.
 *
 * @param {string[]} versions
 * @param {(Mocha: Function, frameworkVersion: string) => Function} wrapMochaRun
 * @returns {void}
 */
function addMochaRunHooks (versions, wrapMochaRun) {
  const patchedMochaConstructors = new WeakSet()

  /**
   * @param {Function} Mocha
   * @param {string} frameworkVersion
   * @returns {Function}
   */
  function wrapMochaOnce (Mocha, frameworkVersion) {
    if (patchedMochaConstructors.has(Mocha)) return Mocha
    patchedMochaConstructors.add(Mocha)
    return wrapMochaRun(Mocha, frameworkVersion)
  }

  /**
   * @param {object|Function} MochaPackage
   * @param {string} frameworkVersion
   * @returns {object|Function}
   */
  function wrapMochaPackage (MochaPackage, frameworkVersion) {
    wrapMochaOnce(MochaPackage.default ?? MochaPackage, frameworkVersion)
    return MochaPackage
  }

  addHook({
    name: 'mocha',
    versions,
    filePattern: String.raw`lib/mocha\.(?:c?js)$`,
  }, wrapMochaOnce)

  // Mocha 12's ESM package root can load lib/mocha.cjs before the CJS hook observes it. ESM imports report the
  // package root while synchronous require reports index.js, so hook both views. Keeping the namespace intact makes
  // the ESM hook skip its separate default-export callback, and wrapMochaOnce deduplicates loaders exposing both.
  addHook({
    name: 'mocha',
    versions: ['>=12.0.0'],
    patchDefault: false,
  }, wrapMochaPackage)

  addHook({
    name: 'mocha',
    versions: ['>=12.0.0'],
    file: 'index.js',
    patchDefault: false,
  }, wrapMochaPackage)
}

// mocha-each support
addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1'],
}, mochaEach => {
  if (patched.has(mochaEach)) return mochaEach

  patched.add(mochaEach)

  return shimmer.wrapFunction(mochaEach, mochaEach => function (...args) {
    const [params] = args
    const { it, ...rest } = mochaEach.apply(this, args)
    return {
      it: function (title) {
        parameterizedTestCh.publish({ title, params })
        it.apply(this, arguments)
      },
      ...rest,
    }
  })
})

// support for start line
addHook({
  name: 'mocha',
  versions: [MINIMUM_MOCHA_VERSION],
  file: 'lib/suite.js',
}, (SuitePackage) => {
  const Suite = SuitePackage.Suite ?? SuitePackage
  shimmer.wrap(Suite.prototype, 'addTest', addTest => function (test) {
    const callSites = getCallSites()
    const testCallSite = callSites.find(site => site.getFileName() === test.file)
    if (testCallSite) {
      testToStartLine.set(test, testCallSite.getLineNumber())
    }
    return addTest.apply(this, arguments)
  })
  return SuitePackage
})

module.exports = { addMochaRunHooks }
