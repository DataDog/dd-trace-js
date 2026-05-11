'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('node:child_process')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_COMMAND,
  TEST_FINAL_STATUS,
  TEST_LEVEL_EVENT_TYPES,
  TEST_NAME,
  TEST_PARENT_TRACE_ID,
  TEST_SESSION_NAME,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_STATUS,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')

describe('node:test', () => {
  let cwd
  let receiver
  let childProcess

  useSandbox([], true)

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async function () {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver.stop()
  })

  function getEvents (payloads) {
    return payloads.flatMap(({ payload }) => payload.events)
  }

  function getTests (events) {
    return events.filter(event => event.type === 'test').map(event => event.content)
  }

  it('can run and report tests, suites, modules and sessions', async () => {
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const metadataDicts = payloads.flatMap(({ payload }) => payload.metadata)

        metadataDicts.forEach(metadata => {
          for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
            assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-node-test-session')
          }
        })

        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const testEvents = events.filter(event => event.type === 'test')

        assert.ok(testSessionEvent)
        assert.ok(testModuleEvent)
        assert.strictEqual(testSuiteEvents.length, 1)
        assert.strictEqual(
          testEvents.length,
          3,
          JSON.stringify(events.map(event => ({
            type: event.type,
            resource: event.content.resource,
            name: event.content.meta?.[TEST_NAME],
            status: event.content.meta?.[TEST_STATUS],
          })))
        )

        assert.ok(testSessionEvent.content.resource.includes('test_session.node --test'))
        assert.ok(testModuleEvent.content.resource.includes('test_module.node --test'))
        assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
        assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'fail')
        assert.strictEqual(testSessionEvent.content.meta[TEST_TYPE], 'test')
        assert.strictEqual(testModuleEvent.content.meta[TEST_TYPE], 'test')

        const testSuite = testSuiteEvents[0].content
        assert.strictEqual(testSuite.meta[TEST_STATUS], 'fail')
        assert.strictEqual(testSuite.meta[TEST_COMMAND], 'node --test')
        assert.strictEqual(testSuite.meta[TEST_SOURCE_FILE], 'ci-visibility/node-test-tests/test-visibility.cjs')
        assert.strictEqual(testSuite.metrics[TEST_SOURCE_START], 1)

        const tests = testEvents.map(event => event.content)
        const passedTest = tests.find(test => test.meta[TEST_NAME] === 'node test visibility > can report passed test')
        const failedTest = tests.find(test => test.meta[TEST_NAME] === 'node test visibility > can report failed test')
        const skippedTest = tests.find(
          test => test.meta[TEST_NAME] === 'node test visibility > can report skipped test'
        )

        assert.ok(passedTest)
        assert.ok(failedTest)
        assert.ok(skippedTest)

        assert.strictEqual(passedTest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(passedTest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(passedTest.meta['test.before_each'], 'true')
        assert.strictEqual(passedTest.meta['test.after_each'], 'true')
        assert.strictEqual(passedTest.meta['test.body'], 'true')
        assert.strictEqual(failedTest.meta[TEST_STATUS], 'fail')
        assert.strictEqual(failedTest.meta[TEST_FINAL_STATUS], 'fail')
        assert.strictEqual(skippedTest.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedTest.meta[TEST_FINAL_STATUS], 'skip')

        tests.forEach(test => {
          assert.strictEqual(test.meta[TEST_COMMAND], 'node --test')
          assert.strictEqual(test.meta[TEST_SOURCE_FILE], 'ci-visibility/node-test-tests/test-visibility.cjs')
        })
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/test-visibility.cjs',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TEST_SESSION_NAME: 'my-node-test-session',
          DD_SERVICE: undefined,
        },
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 1)
  })

  it('can run advanced native node:test suite patterns under dd-trace', async () => {
    let testOutput = ''
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testModuleEvent = events.find(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const tests = events.filter(event => event.type === 'test').map(event => event.content)

        assert.ok(testSessionEvent, testOutput)
        assert.ok(testModuleEvent, testOutput)
        assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testModuleEvent.content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testSuiteEvents.length, 1)
        assert.strictEqual(testSuiteEvents[0].content.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testSuiteEvents[0].content.meta[TEST_SOURCE_FILE], (
          'ci-visibility/node-test-tests/advanced-suite.mjs'
        ))
        assert.strictEqual(
          tests.length,
          5,
          JSON.stringify(tests.map(test => ({
            name: test.meta[TEST_NAME],
            status: test.meta[TEST_STATUS],
            resource: test.resource,
          })))
        )

        const testNames = tests.map(test => test.meta[TEST_NAME])
        assert.deepStrictEqual(new Set(testNames), new Set([
          'advanced node test suite > runs async tests with subtests',
          'advanced node test suite > runs async tests with subtests > reports awaited subtests',
          'advanced node test suite > runs callback style tests',
          'advanced node test suite > runs default test export aliases',
          'advanced node test suite > reports todo tests',
        ]))

        const asyncTest = tests.find(
          test => test.meta[TEST_NAME] === 'advanced node test suite > runs async tests with subtests'
        )
        assert.strictEqual(asyncTest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(asyncTest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(asyncTest.meta['test.before_each'], 'true')
        assert.strictEqual(asyncTest.meta['test.after_each'], 'true')
        assert.strictEqual(asyncTest.meta['test.body'], 'async')

        const subtest = tests.find(
          test => test.meta[TEST_NAME] === (
            'advanced node test suite > runs async tests with subtests > reports awaited subtests'
          )
        )
        assert.strictEqual(subtest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(subtest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(subtest.meta[TEST_PARENT_TRACE_ID], asyncTest.trace_id.toString())
        assert.strictEqual(subtest.meta['test.subtest'], 'true')

        const callbackTest = tests.find(
          test => test.meta[TEST_NAME] === 'advanced node test suite > runs callback style tests'
        )
        assert.strictEqual(callbackTest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(callbackTest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(callbackTest.meta['test.callback'], 'true')

        const defaultExportTest = tests.find(
          test => test.meta[TEST_NAME] === 'advanced node test suite > runs default test export aliases'
        )
        assert.strictEqual(defaultExportTest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(defaultExportTest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(defaultExportTest.meta['test.default_export'], 'true')

        const todoTest = tests.find(
          test => test.meta[TEST_NAME] === 'advanced node test suite > reports todo tests'
        )
        assert.strictEqual(todoTest.meta[TEST_STATUS], 'skip')
        assert.strictEqual(todoTest.meta[TEST_FINAL_STATUS], 'skip')
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/advanced-suite.mjs',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
        },
      }
    )

    childProcess.stdout?.on('data', chunk => {
      testOutput += chunk.toString()
    })
    childProcess.stderr?.on('data', chunk => {
      testOutput += chunk.toString()
    })

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })

  it('can run and report multiple discovered test files', async () => {
    const requestCounts = {
      settings: 0,
      gitSearchCommits: 0,
    }
    const countRequests = ({ url }) => {
      if (url.endsWith('/api/v2/libraries/tests/services/setting')) {
        requestCounts.settings++
      } else if (url.endsWith('/api/v2/git/repository/search_commits')) {
        requestCounts.gitSearchCommits++
      }
    }
    receiver.on('message', countRequests)

    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = getEvents(payloads)
        const testSessionEvents = events.filter(event => event.type === 'test_session_end')
        const testModuleEvents = events.filter(event => event.type === 'test_module_end')
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const tests = getTests(events)

        const eventSummary = JSON.stringify(events.map(event => ({
          type: event.type,
          resource: event.content.resource,
          name: event.content.meta?.[TEST_NAME],
          status: event.content.meta?.[TEST_STATUS],
        })))

        assert.strictEqual(testSessionEvents.length, 1, eventSummary)
        assert.strictEqual(testModuleEvents.length, 1)
        assert.strictEqual(testSuiteEvents.length, 2)
        assert.deepStrictEqual(new Set(tests.map(test => test.meta[TEST_NAME])), new Set([
          'node test multi file first > reports the first file',
          'node test multi file second > reports the second file',
        ]))
        assert.deepStrictEqual(new Set(testSuiteEvents.map(event => event.content.meta[TEST_SOURCE_FILE])), new Set([
          'ci-visibility/node-test-tests/multi-file/first.test.cjs',
          'ci-visibility/node-test-tests/multi-file/second.test.cjs',
        ]))

        for (const test of tests) {
          assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          assert.strictEqual(test.meta[TEST_FINAL_STATUS], 'pass')
        }
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/multi-file/*.test.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    receiver.off('message', countRequests)

    assert.strictEqual(exitCode, 0)
    assert.deepStrictEqual(requestCounts, {
      settings: 1,
      gitSearchCommits: 1,
    })
  })

  it('flushes worker test payloads before the suite finishes', async () => {
    let exited = false
    const firstTestName = 'reports before worker suite finishes'
    const firstPayloadPromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        receiver.off('message', messageHandler)
        reject(new Error('Timed out waiting for intermediate node:test worker payload.'))
      }, 6_000)
      function messageHandler ({ url, payload }) {
        if (url !== '/api/v2/citestcycle') {
          return
        }

        const firstTest = payload.events?.some(event => {
          return event.type === 'test' && event.content.meta[TEST_NAME] === firstTestName
        })
        if (firstTest) {
          clearTimeout(timeoutId)
          receiver.off('message', messageHandler)
          resolve()
        }
      }
      receiver.on('message', messageHandler)
    })

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/intermediate-flush.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )
    const exitPromise = once(childProcess, 'exit').then(([exitCode]) => {
      exited = true
      return exitCode
    })

    await firstPayloadPromise
    assert.strictEqual(exited, false)
    assert.strictEqual(await exitPromise, 0)
  })

  it('reports failures from beforeEach and afterEach hooks', async () => {
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = getEvents(payloads)
        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const testSuiteEvent = events.find(event => event.type === 'test_suite_end')
        const tests = getTests(events)

        assert.strictEqual(testSessionEvent.content.meta[TEST_STATUS], 'fail')
        assert.strictEqual(testSuiteEvent.content.meta[TEST_STATUS], 'fail')
        assert.strictEqual(tests.length, 3)

        const beforeEachFailure = tests.find(
          test => test.meta[TEST_NAME] === 'node test failing hooks > reports beforeEach failures'
        )
        assert.strictEqual(beforeEachFailure.meta[TEST_STATUS], 'fail')
        assert.strictEqual(beforeEachFailure.meta[TEST_FINAL_STATUS], 'fail')
        assert.ok(!(beforeEachFailure.meta['test.body']))

        const afterEachFailure = tests.find(
          test => test.meta[TEST_NAME] === 'node test failing hooks > reports afterEach failures'
        )
        assert.strictEqual(afterEachFailure.meta[TEST_STATUS], 'fail')
        assert.strictEqual(afterEachFailure.meta[TEST_FINAL_STATUS], 'fail')
        assert.strictEqual(afterEachFailure.meta['test.body'], 'afterEach')

        const passingTest = tests.find(
          test => test.meta[TEST_NAME] === 'node test failing hooks > reports passing tests after hook failures'
        )
        assert.strictEqual(passingTest.meta[TEST_STATUS], 'pass')
        assert.strictEqual(passingTest.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(passingTest.meta['test.before_each'], 'true')
        assert.strictEqual(passingTest.meta['test.after_each'], 'true')
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/failing-hooks.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 1)
  })

  it('reports context skip/todo calls and keeps concurrent test spans isolated', async () => {
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const tests = getTests(getEvents(payloads))
        assert.strictEqual(tests.length, 4)

        const skipped = tests.find(
          test => test.meta[TEST_NAME] === 'node test context controls > reports context skip calls'
        )
        assert.strictEqual(skipped.meta[TEST_STATUS], 'skip')
        assert.strictEqual(skipped.meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(skipped.meta['test.context_skip'], 'true')

        const todo = tests.find(
          test => test.meta[TEST_NAME] === 'node test context controls > reports context todo calls'
        )
        assert.strictEqual(todo.meta[TEST_STATUS], 'skip')
        assert.strictEqual(todo.meta[TEST_FINAL_STATUS], 'skip')
        assert.strictEqual(todo.meta['test.context_todo'], 'true')

        const first = tests.find(
          test => test.meta[TEST_NAME] === 'node test context controls > keeps concurrent test span context isolated'
        )
        assert.strictEqual(first.meta[TEST_STATUS], 'pass')
        assert.strictEqual(first.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(first.meta['test.concurrent'], 'first')

        const second = tests.find(
          test => test.meta[TEST_NAME] === 'node test context controls > keeps the second concurrent span isolated'
        )
        assert.strictEqual(second.meta[TEST_STATUS], 'pass')
        assert.strictEqual(second.meta[TEST_FINAL_STATUS], 'pass')
        assert.strictEqual(second.meta['test.concurrent'], 'second')
      }
    )

    childProcess = exec(
      'node --test --test-concurrency=2 ci-visibility/node-test-tests/context-skip-concurrency.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })

  it('parents integration spans from tests and hooks to the active test span', async () => {
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = getEvents(payloads)
        const tests = getTests(events)
        const spans = events.filter(event => event.type === 'span').map(event => event.content)
        const testSpan = tests.find(
          test => test.meta[TEST_NAME] === 'node test http context > parents http spans to the active test span'
        )
        assert.ok(testSpan)
        assert.strictEqual(testSpan.meta[TEST_STATUS], 'pass')
        assert.strictEqual(testSpan.meta['test.before_each_http'], 'true')
        assert.strictEqual(testSpan.meta['test.after_each_http'], 'true')
        assert.strictEqual(testSpan.meta['test.http_body'], 'true')

        const childHttpSpans = spans.filter(span => {
          return span.name === 'http.request' &&
            span.trace_id.toString() === testSpan.trace_id.toString() &&
            span.parent_id.toString() === testSpan.span_id.toString()
        })
        const httpUrls = childHttpSpans.map(span => span.meta['http.url'])
        assert.strictEqual(childHttpSpans.length, 3)
        assert.ok(httpUrls.some(url => url.endsWith('/before')))
        assert.ok(httpUrls.some(url => url.endsWith('/body')))
        assert.ok(httpUrls.some(url => url.endsWith('/after')))
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/http-context.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })

  it('tags settings request failures on the session and test spans', async () => {
    receiver.setSettingsResponseCode(404)

    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const events = getEvents(payloads)
        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        const test = getTests(events)[0]

        assert.strictEqual(testSessionEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
        assert.strictEqual(test.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true')
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/config-paths.cjs',
      {
        cwd,
        env: getCiVisAgentlessConfig(receiver.port),
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })

  it('tags tests when DD_SERVICE is user provided', async () => {
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      payloads => {
        const test = getTests(getEvents(payloads))[0]
        assert.strictEqual(test.meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'true')
      }
    )

    childProcess = exec(
      'node --test ci-visibility/node-test-tests/config-paths.cjs',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_SERVICE: 'node-test-user-service',
        },
      }
    )

    const [[exitCode]] = await Promise.all([
      once(childProcess, 'exit'),
      eventsPromise,
    ])
    assert.strictEqual(exitCode, 0)
  })
})
