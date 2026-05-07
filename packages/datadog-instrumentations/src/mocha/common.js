'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const { getCallSites } = require('../../../dd-trace/src/plugins/util/stacktrace')
const { DD_MAJOR } = require('../../../../version')
const { testToStartLine } = require('./utils')

const MINIMUM_MOCHA_VERSION = DD_MAJOR >= 6 ? '>=8.0.0' : '>=5.2.0'

const parameterizedTestCh = channel('ci:mocha:test:parameterize')
const patched = new WeakSet()

// mocha-each support
addHook({
  name: 'mocha-each',
  versions: ['>=2.0.1'],
}, mochaEach => {
  if (patched.has(mochaEach)) return mochaEach

  patched.add(mochaEach)

  return shimmer.wrapFunction(mochaEach, mochaEach => function () {
    const [params] = arguments
    const { it, ...rest } = mochaEach.apply(this, arguments)
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
}, (Suite) => {
  shimmer.wrap(Suite.prototype, 'addTest', addTest => function (test) {
    const callSites = getCallSites()
    let startLine
    const testCallSite = callSites.find(site => site.getFileName() === test.file)
    if (testCallSite) {
      startLine = testCallSite.getLineNumber()
      testToStartLine.set(test, startLine)
    }
    return addTest.apply(this, arguments)
  })
  return Suite
})
