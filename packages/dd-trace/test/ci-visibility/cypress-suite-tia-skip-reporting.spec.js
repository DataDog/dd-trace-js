'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const getConfig = require('../../src/config')
const { AgentlessCiVisibilityEncoder } = require('../../src/encode/agentless-ci-visibility')
const {
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_TESTS_SKIPPED,
  TEST_SUITE,
  getTestModuleCommonTags,
  getTestSessionCommonTags,
} = require('../../src/plugins/util/test')

const root = process.cwd()

describe('Cypress suite Test Impact Analysis skip reporting', () => {
  let tracer, traces, encoder

  beforeEach(() => {
    traces = []
    encoder = new AgentlessCiVisibilityEncoder({ flush: sinon.stub() }, { tags: {} })
    class Exporter {
      export (trace) { traces.push(trace) }
      addMetadataTags () {}
      flush (done) { done?.() }
    }
    const Tracer = proxyquire('../../src/opentracing/tracer', { '../exporter': () => Exporter })
    tracer = new Tracer(getConfig())
  })

  afterEach(() => {
    sinon.restore()
  })

  function events () {
    for (const trace of traces) encoder.encode(trace)
    const payload = msgpack.decode(encoder.makePayload(), { useBigInt64: true })
    assert.ok(payload && typeof payload === 'object' && 'events' in payload)
    assert.ok(Array.isArray(payload.events))
    return payload.events
  }

  function assertSuite (event, count) {
    assert.strictEqual(event.type, 'test_suite_end')
    if (count === undefined) {
      assert.strictEqual(Object.hasOwn(event.content.metrics, TEST_ITR_SKIPPING_COUNT), false)
      assert.strictEqual(Object.hasOwn(event.content.meta, TEST_ITR_TESTS_SKIPPED), false)
    } else {
      assert.strictEqual(event.content.metrics[TEST_ITR_SKIPPING_COUNT], count)
      assert.strictEqual(event.content.meta[TEST_ITR_TESTS_SKIPPED], count > 0 ? 'true' : 'false')
      assert.ok(Number.isInteger(event.content.metrics[TEST_ITR_SKIPPING_COUNT]))
    }
  }

  function finishSession (plugin) {
    plugin.testModuleSpan.finish()
    plugin.testSessionSpan.finish()
  }

  describe('Cypress test skipping', () => {
    let plugin, tasks

    beforeEach(() => {
      const load = proxyquire.noPreserveCache()
      plugin = load('../../../datadog-plugin-cypress/src/cypress-plugin', {})
      plugin.resetRunState()
      plugin.tracer = {
        _tracer: tracer, startSpan: tracer.startSpan.bind(tracer), extract: tracer.extract.bind(tracer),
      }
      plugin.cypressConfig = { version: '14.5.4', isTextTerminal: true }
      plugin.isItrEnabled = true
      plugin.isSuitesSkippingEnabled = true
      plugin.isCodeCoverageEnabled = false
      plugin.command = 'cypress run'
      plugin.frameworkVersion = '14.5.4'
      plugin.repositoryRoot = root
      plugin.rootDir = root
      plugin.testSessionSpan = tracer.startSpan('cypress.test_session', {
        tags: getTestSessionCommonTags(plugin.command, plugin.frameworkVersion, 'cypress'),
      })
      plugin.testModuleSpan = tracer.startSpan('cypress.test_module', {
        childOf: plugin.testSessionSpan,
        tags: getTestModuleCommonTags(plugin.command, plugin.frameworkVersion, 'cypress'),
      })
      tasks = plugin.getTasks()
    })

    function startSuite (suite) {
      tasks['dd:testSuiteStart']({ testSuite: suite, testSuiteAbsolutePath: path.join(root, suite) })
      return plugin.testSuiteSpan
    }

    function skip (suite, name, id = name) {
      return tasks['dd:beforeEach']({ testSuite: suite, testName: name, testId: id })
    }

    function finishSuites (spans) {
      for (const span of spans) span.finish()
      finishSession(plugin)
      return events().filter(event => event.type === 'test_suite_end')
    }

    it('counts TIA skips per suite with the session deduplication semantics', async () => {
      plugin.testsToSkip = [{ suite: 'a.js', name: 'one' }, { suite: 'a.js', name: 'two' },
        { suite: 'b.js', name: 'one' }]
      const a = startSuite('a.js')
      const b = startSuite('b.js')
      assert.deepStrictEqual(skip('a.js', 'one'), { shouldSkip: true })
      assert.deepStrictEqual(skip('b.js', 'one'), { shouldSkip: true })
      assert.deepStrictEqual(skip('a.js', 'two'), { shouldSkip: true })
      skip('a.js', 'two')
      // Framework skips never enter beforeEach; a passing execution does not increment the count.
      skip('a.js', 'passing')
      plugin.activeTestSpan.finish()
      a.finish()
      b.finish()
      plugin._isInit = true
      await plugin.afterRun({ totalTests: 5, totalPassed: 1, totalPending: 4 })
      const reported = events()
      const session = reported.find(event => event.type === 'test_session_end').content
      assert.strictEqual(session.metrics[TEST_ITR_SKIPPING_COUNT], 3)
      assert.strictEqual(session.meta[TEST_ITR_TESTS_SKIPPED], 'true')
      const suites = reported.filter(event => event.type === 'test_suite_end')
      assertSuite(suites.find(event => event.content.meta[TEST_SUITE] === 'a.js'), 2)
      assertSuite(suites.find(event => event.content.meta[TEST_SUITE] === 'b.js'), 1)
      assert.strictEqual(plugin.skippedTests.length, 3)
    })

    it('counts tests with the same name and distinct IDs separately', () => {
      plugin.testsToSkip = [{ suite: 'suite.js', name: 'one' }]
      const span = startSuite('suite.js')
      skip('suite.js', 'one', 'first')
      skip('suite.js', 'one', 'second')
      skip('suite.js', 'one', 'first')
      assertSuite(finishSuites([span])[0], 2)
      assert.strictEqual(plugin.skippedTests.length, 2)
    })

    it('deduplicates skip tasks by name when Cypress does not provide an ID', () => {
      plugin.testsToSkip = [{ suite: 'suite.js', name: 'one' }]
      const span = startSuite('suite.js')
      const test = { testSuite: 'suite.js', testName: 'one' }
      assert.deepStrictEqual(tasks['dd:beforeEach'](test), { shouldSkip: true })
      assert.deepStrictEqual(tasks['dd:beforeEach'](test), { shouldSkip: true })
      assertSuite(finishSuites([span])[0], 1)
      assert.strictEqual(plugin.skippedTests.length, 1)
    })

    it('counts concurrent skip tasks against the owning suite', async () => {
      plugin.testsToSkip = ['a.js', 'b.js'].flatMap(suite =>
        Array.from({ length: 100 }, (_, i) => ({ suite, name: `test-${i}` })))
      const a = startSuite('a.js')
      const b = startSuite('b.js')
      await Promise.all(plugin.testsToSkip.map(({ suite, name }) => Promise.resolve().then(() => skip(suite, name))))
      for (const suite of finishSuites([a, b])) assertSuite(suite, 100)
      assert.strictEqual(plugin.skippedTests.length, 200)
    })

    const modes = ['framework skips', 'empty', 'passing', 'forced', 'disabled', 'skipping disabled', 'TIA disabled']
    for (const mode of modes) {
      it(`reports zero or omits fields for ${mode}`, () => {
        plugin.isItrEnabled = mode !== 'TIA disabled'
        plugin.isSuitesSkippingEnabled = mode !== 'skipping disabled' && plugin.isItrEnabled
        if (mode === 'forced') {
          plugin.testsToSkip = [{ suite: 'suite.js', name: 'one' }]
          plugin.unskippableSuites = ['suite.js']
        }
        if (mode === 'disabled') {
          plugin.isTestManagementTestsEnabled = true
          plugin.testManagementTests = {
            cypress: {
              suites: {
                'suite.js': {
                  tests: { one: { properties: { disabled: true } } },
                },
              },
            },
          }
        }
        const span = startSuite('suite.js')
        if (mode !== 'empty' && mode !== 'framework skips') {
          const result = skip('suite.js', 'one')
          if (mode === 'disabled') assert.deepStrictEqual(result, { shouldSkip: true })
          plugin.activeTestSpan?.finish()
        }
        assertSuite(finishSuites([span])[0], plugin.isItrEnabled ? 0 : undefined)
        assert.strictEqual(plugin.skippedTests.length, 0)
      })
    }

    it('does not fail skip tasks when the suite could not be instrumented', () => {
      plugin.testsToSkip = [{ suite: 'missing.js', name: 'one' }]
      assert.deepStrictEqual(skip('missing.js', 'one'), { shouldSkip: true })
      assert.strictEqual(plugin.skippedTests.length, 1)
    })

    for (const method of ['context', 'setTag']) {
      it(`preserves test skipping and session counting when suite ${method} throws`, () => {
        const span = startSuite('suite.js')
        plugin.testsToSkip = [{ suite: 'suite.js', name: 'one' }]
        sinon.stub(span, method).throws(new Error('instrumentation failed'))
        assert.deepStrictEqual(skip('suite.js', 'one'), { shouldSkip: true })
        assert.strictEqual(plugin.skippedTests.length, 1)
        assert.strictEqual(plugin.isTestsSkipped, true)
      })
    }
  })
})
