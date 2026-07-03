'use strict'

/* eslint-disable */

const { channel } = require('dc-polyfill')
const tracer = require('dd-trace')

const testSessionStartCh = channel('dd-trace:ci:manual:test-session:start')
const testSessionFinishCh = channel('dd-trace:ci:manual:test-session:finish')
const testSessionAddTagsCh = channel('dd-trace:ci:manual:test-session:addTags')

const testSuiteStartCh = channel('dd-trace:ci:manual:test-suite:start')
const testSuiteFinishCh = channel('dd-trace:ci:manual:test-suite:finish')
const testSuiteAddTagsCh = channel('dd-trace:ci:manual:test-suite:addTags')

const testStartCh = channel('dd-trace:ci:manual:test:start')
const testFinishCh = channel('dd-trace:ci:manual:test:finish')

function assertActiveSpan (name) {
  if (process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED === 'false') return
  global.assert.equal(tracer.scope().active().context()._name, name)
}

function createChildSpan (resource) {
  if (process.env.DD_CIVISIBILITY_MANUAL_API_ENABLED === 'false') return
  const activeSpan = tracer.scope().active()
  if (!activeSpan) return
  const childSpan = tracer.startSpan(resource, {
    childOf: activeSpan
  })
  childSpan.finish()
}

function runTest (test) {
  return testStartCh.runStores({ testName: test.description, testSuite: global.testSuite }, async () => {
    let testStatus = 'pass'
    let testError = null
    assertActiveSpan('test-api-manual.test')
    global.beforeEachHooks.forEach(beforeEach => {
      beforeEach(test.description)
    })
    try {
      await test.fn()
      console.log(`✓ ${test.description}`)
    } catch (e) {
      testError = e
      testStatus = 'fail'
      console.log(`x ${test.description}: ${e}`)
    }
    global.afterEachHooks.forEach(afterEach => {
      afterEach(testStatus, testError)
    })
    testFinishCh.publish({ status: testStatus, error: testError })
    return testStatus
  })
}

function runTests () {
  const promises = global.tests.map(runTest)
  return Promise.all(promises)
}

function runSuite () {
  let suiteStatus = 'pass'
  let suiteError = null
  return testSuiteStartCh.runStores({ testSuite: global.testSuite }, async () => {
    try {
      assertActiveSpan('test-api-manual.test_suite')
      testSuiteAddTagsCh.publish({ 'test.suite.custom.tag': 'custom.suite.value' })
      createChildSpan('suite.custom.span')
      const testStatuses = await runTests()
      if (testStatuses.includes('fail')) {
        suiteStatus = 'fail'
      }
    } catch (e) {
      suiteStatus = 'fail'
      suiteError = e
      throw e
    } finally {
      testSuiteFinishCh.publish({ testSuite: global.testSuite, status: suiteStatus, error: suiteError })
    }
    return suiteStatus
  })
}

function runSession () {
  let sessionStatus = 'pass'
  let sessionError = null
  return testSessionStartCh.runStores({
    command: 'fake-test-framework',
    frameworkVersion: '1.0.0',
    testSessionName: 'manual-api-session'
  }, async () => {
    try {
      assertActiveSpan('test-api-manual.test_module')
      testSessionAddTagsCh.publish({ 'test.session.custom.tag': 'custom.session.value' })
      createChildSpan('session.custom.span')
      sessionStatus = await runSuite()
    } catch (e) {
      sessionStatus = 'fail'
      sessionError = e
      throw e
    } finally {
      testSessionFinishCh.publish({ status: sessionStatus, error: sessionError })
    }
  })
}

runSession().catch(err => {
  console.error(err)
  process.exitCode = 1
})
