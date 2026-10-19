'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { getTestAnnotations, copyTestAnnotations } = require('../../../dd-trace/src/ci-visibility/test-annotations')
const { getCallSites } = require('../../../dd-trace/src/plugins/util/stacktrace')
const { DD_MAJOR } = require('../../../../version')
const { testToStartLine } = require('./utils')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const patched = new WeakSet()

/** @typedef {{ moduleBaseDir?: string }} MochaHookMeta */

/**
 * Registers every Mocha package view that can expose the constructor.
 *
 * @param {string[]} versions
 * @param {(Mocha: Function, frameworkVersion: string, hookMeta: MochaHookMeta) => Function} wrapMochaRun
 */
function addMochaRunHooks (versions, wrapMochaRun) {
  const patchedMochaConstructors = new WeakMap()

  /**
   * @param {Function} Mocha
   * @param {string} frameworkVersion
   * @param {boolean | undefined} isIitm
   * @param {{ moduleBaseDir: string } | undefined} hookMeta
   * @returns {Function}
   */
  function wrapMochaOnce (Mocha, frameworkVersion, isIitm, hookMeta) {
    let metadata = patchedMochaConstructors.get(Mocha)
    if (metadata) {
      // A bundler can expose the constructor before an ordinary loader supplies its package directory.
      metadata.moduleBaseDir ??= hookMeta?.moduleBaseDir
      return Mocha
    }
    metadata = { moduleBaseDir: hookMeta?.moduleBaseDir }
    patchedMochaConstructors.set(Mocha, metadata)
    shimmer.wrap(Mocha.prototype, 'ui', ui => function () {
      const result = ui.apply(this, arguments)
      this.suite.on('pre-require', context => preserveDeclarationAnnotations(context, Mocha))
      return result
    })
    return wrapMochaRun(Mocha, frameworkVersion, metadata)
  }

  /**
   * @param {object|Function} MochaPackage
   * @param {string} frameworkVersion
   * @param {boolean | undefined} isIitm
   * @param {{ moduleBaseDir: string } | undefined} hookMeta
   * @returns {object|Function}
   */
  function wrapMochaPackage (MochaPackage, frameworkVersion, isIitm, hookMeta) {
    wrapMochaOnce(MochaPackage.default ?? MochaPackage, frameworkVersion, isIitm, hookMeta)
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

/**
 * @param {object} context
 * @param {Function} Mocha
 */
function preserveDeclarationAnnotations (context, Mocha) {
  for (const key of ['it', 'specify', 'test', 'xit', 'xspecify']) {
    const declare = context[key]
    if (typeof declare !== 'function') continue
    context[key] = shimmer.wrapFunction(declare, wrapDeclaration)
    // Older Mocha interfaces copy declarations to exports before this listener runs.
    for (const exported of ['it', 'specify', 'test', 'xit', 'xspecify']) {
      if (Mocha[exported] === declare) Mocha[exported] = context[key]
    }
    for (const modifier of ['skip', 'only']) {
      if (typeof declare[modifier] === 'function') {
        context[key][modifier] = shimmer.wrapFunction(declare[modifier], wrapDeclaration)
      }
    }
  }
}

/** @param {Function} original */
function wrapDeclaration (original) {
  return function (title, fn) {
    const test = original.apply(this, arguments)
    // Mocha discards callbacks on skipped tests before constructing its Test object.
    if (test && !test.fn) test._ddDeclaredAnnotations = getTestAnnotations(fn)
    return test
  }
}

// Carry declaration policy alongside each serialized execution, including duplicate full titles.
addHook({
  name: 'mocha',
  versions: ['>=8.0.0'],
  filePattern: String.raw`lib/test\.(?:c?js)$`,
}, TestPackage => {
  const Test = TestPackage.Test ?? TestPackage
  shimmer.wrap(Test.prototype, 'serialize', serialize => function () {
    const serialized = serialize.apply(this, arguments)
    const { mustFail, noAutoRetry } = this._ddTestAnnotations || this._ddDeclaredAnnotations ||
      getTestAnnotations(this.fn)
    serialized._ddTestAnnotations = { mustFail, noAutoRetry }
    return serialized
  })
  return TestPackage
})

// mocha-each support
addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1'],
}, mochaEach => {
  if (patched.has(mochaEach)) return mochaEach

  patched.add(mochaEach)

  return shimmer.wrapFunction(mochaEach, mochaEach => function (...args) {
    const [params, declare = global.it] = args
    let sourceTestFn
    /** @param {Function} original */
    const wrapRow = original => function (title, fn) {
      copyTestAnnotations(sourceTestFn, fn)
      return original.apply(this, arguments)
    }
    const rowDeclaration = shimmer.wrapFunction(declare, wrapRow)
    for (const modifier of ['skip', 'only']) {
      if (typeof declare[modifier] === 'function') {
        rowDeclaration[modifier] = shimmer.wrapFunction(declare[modifier], wrapRow)
      }
    }
    const declarations = mochaEach.call(this, params, rowDeclaration, ...args.slice(2))
    /** @param {Function} original */
    const wrapEachDeclaration = original => function (title, fn) {
      sourceTestFn = fn
      parameterizedTestCh.publish({ title, params })
      return original.apply(this, arguments)
    }
    declarations.it = shimmer.wrapFunction(declarations.it, wrapEachDeclaration)
    for (const modifier of ['skip', 'only']) {
      if (typeof declarations.it[modifier] === 'function') {
        declarations.it[modifier] = shimmer.wrapFunction(declarations.it[modifier], wrapEachDeclaration)
      }
    }
    return declarations
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
