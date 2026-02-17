'use strict'

const shimmer = require('../../datadog-shimmer')

const { addHook, channel } = require('./helpers/instrument')

const testSessionStartCh = channel('ci:node-test:session:start')
const testSessionFinishCh = channel('ci:node-test:session:finish')
const testSuiteStartCh = channel('ci:node-test:test-suite:start')
const testSuiteFinishCh = channel('ci:node-test:test-suite:finish')
const testStartCh = channel('ci:node-test:test:start')
const testFinishCh = channel('ci:node-test:test:finish')

function getTestKey (data) {
  return `${data.file ?? ''}:${data.line ?? 0}:${data.column ?? 0}:${String(data.name)}:${data.nesting ?? 0}`
}

addHook({
  name: 'node:test',
  versions: ['>=18.0.0'],
}, (nodeTest, frameworkVersion) => {
  if (!testFinishCh.hasSubscribers) {
    return nodeTest
  }

  const wrapRun = (run) => function (options) {
    const stream = run.call(this, options)

    const processArgv = process.argv.slice(2).join(' ')
    const command = ['node', ...process.execArgv, processArgv].filter(Boolean).join(' ')
    testSessionStartCh.publish({ command, frameworkVersion: frameworkVersion || process.version })

    let suiteStarted = false
    let currentTestFilePath = null
    const testToCtx = new Map()

    stream.on('test:start', (data) => {
      const key = getTestKey(data)
      const filePath = data.file && data.file !== '[eval]' ? data.file : require.main?.filename
      const testSuiteAbsolutePath = filePath || process.cwd()
      const isStep = data.nesting > 0

      if (!suiteStarted && testSuiteStartCh.hasSubscribers) {
        currentTestFilePath = testSuiteAbsolutePath
        testSuiteStartCh.runStores({ testSuiteAbsolutePath: currentTestFilePath }, () => {})
        suiteStarted = true
      }

      const ctx = {
        testName: data.name,
        testSuiteAbsolutePath: currentTestFilePath || testSuiteAbsolutePath,
        title: data.name,
        testStartLine: data.line,
        nesting: data.nesting,
        fullName: data.name,
        isStep,
        _testKey: key,
      }

      testToCtx.set(key, ctx)
      testStartCh.runStores(ctx, () => {})
    })

    const finishTest = (data, status) => {
      const key = getTestKey(data)
      const ctx = testToCtx.get(key)
      if (ctx) {
        const payload = { status, isStep: ctx.isStep, _testKey: key, ...ctx }
        testFinishCh.publish(payload)
        testToCtx.delete(key)
      }
    }

    stream.on('test:pass', (data) => {
      const status = data.details?.passed === false ? 'fail' : 'pass'
      finishTest(data, status)
    })

    stream.on('test:fail', (data) => {
      finishTest(data, 'fail')
    })

    stream.on('test:complete', (data) => {
      const key = getTestKey(data)
      const ctx = testToCtx.get(key)
      if (ctx) {
        const status = data.details?.passed === true ? 'pass' : (data.details?.passed === false ? 'fail' : 'skip')
        testFinishCh.publish({ status, isStep: ctx.isStep, _testKey: key, ...ctx })
        testToCtx.delete(key)
      }
    })

    stream.on('test:summary', (data) => {
      const status = data.success ? 'pass' : 'fail'
      const error = status === 'fail' ? new Error(`Failed tests: ${data.counts?.failed ?? 0}.`) : undefined

      if (suiteStarted && testSuiteFinishCh.hasSubscribers) {
        testSuiteFinishCh.publish({ status, testSuiteAbsolutePath: currentTestFilePath }, () => {})
      }

      testSessionFinishCh.publish({ status, error })
    })

    return stream
  }

  if (typeof nodeTest.run === 'function') {
    shimmer.wrap(nodeTest, 'run', wrapRun)
  }

  return nodeTest
})
