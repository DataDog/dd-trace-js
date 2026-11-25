'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('node:child_process')

const { describe, it, before, beforeEach, afterEach } = require('mocha')

const { assertObjectContains, sandboxCwd, useSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { TEST_NAME, TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')
const { getBabelDependencies } = require('./babel-dependencies')
const { oldest: oldestJestVersion } = require('./versions')

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion

const SUMMARY_TIMEOUT_MS = 30_000

/**
 * @param {{ filename: string, bitmap?: Uint8Array }[]} files
 * @param {string} filename
 * @returns {Set<number>}
 */
function getLines (files, filename) {
  const lines = new Set()
  const bitmap = files.find(file => file.filename === filename)?.bitmap
  for (const [index, byte] of (bitmap ?? []).entries()) {
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) lines.add(index * 8 + bit)
    }
  }
  return lines
}

// What the line coverage records say about the two test files of the fixture project, which each
// call ci-visibility/test/sum.js once.
const modes = [
  ['in band', 'node ./ci-visibility/run-jest.js'],
  ['in workers', 'node ./node_modules/jest/bin/jest --config config-jest.js --maxWorkers=2'],
]

describe(`jest@${JEST_VERSION} per-test line coverage`, () => {
  let receiver
  let childProcess
  let cwd

  useSandbox([
    `jest@${JEST_VERSION}`,
    JEST_VERSION !== 'latest' ? `jest-circus@${JEST_VERSION}` : '',
    `babel-jest@${JEST_VERSION}`,
    ...getBabelDependencies(JEST_VERSION),
  ].filter(Boolean), true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess.kill()
    await receiver.stop()
  })

  for (const [mode, command] of modes) {
    it(`reports a record per test, with the lines it ran, and Shared ${mode}`, async () => {
      const coverageRecords = []
      const testSpanIds = new Set()

      const coveragePromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcov',
        (payloads) => {
          coverageRecords.length = 0
          coverageRecords.push(...payloads
            .flatMap(({ payload }) => payload)
            .flatMap(({ content: { coverages } }) => coverages))
          assert.ok(coverageRecords.some(({ shared }) => shared === 'init'), 'should report Shared init')
        },
        SUMMARY_TIMEOUT_MS
      )
      const eventsPromise = receiver.gatherPayloadsMaxTimeout(
        ({ url }) => url === '/api/v2/citestcycle',
        (payloads) => {
          testSpanIds.clear()
          for (const { payload } of payloads) {
            for (const { type, content } of payload.events) {
              // The coverage payload is decoded without 64-bit integers, so ids lose their low digits there.
              if (type === 'test') testSpanIds.add(String(Number(content.span_id)))
            }
          }
          assert.strictEqual(testSpanIds.size, 2)
        },
        SUMMARY_TIMEOUT_MS
      )

      childProcess = exec(command, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TEST_LINE_COVERAGE_ENABLED: '1',
        },
      })
      await Promise.all([coveragePromise, eventsPromise, once(childProcess, 'exit')])

      const testRecords = coverageRecords.filter(({ span_id: spanId }) => spanId !== undefined)
      assert.deepStrictEqual(
        new Set(testRecords.map(({ span_id: spanId }) => spanId.toString())),
        testSpanIds,
        'every test has exactly one record'
      )
      assert.strictEqual(testRecords.length, testSpanIds.size)
      for (const record of testRecords) {
        assert.ok(record.test_session_id)
        assert.ok(record.test_suite_id)
        assert.strictEqual(record.shared, undefined)
        // Each test file calls sum.js and has its own lines: more than one covered file, with bitmaps.
        const filenames = record.files.map(({ filename }) => filename)
        assertObjectContains(filenames, ['ci-visibility/test/sum.js'])
        assert.ok(record.files.every(({ bitmap }) => bitmap?.length > 0))
      }

      const sharedRecords = coverageRecords.filter(({ shared }) => shared !== undefined)
      assert.ok(sharedRecords.length > 0)
      // Line coverage takes the place of the per-suite coverage.
      assert.strictEqual(coverageRecords.length, testRecords.length + sharedRecords.length)
      for (const record of sharedRecords) {
        assertObjectContains(['init', 'suiteSetup', 'unowned'], [record.shared])
        assert.strictEqual(record.span_id, undefined)
        assert.strictEqual(record.test_suite_id, undefined)
        assert.ok(record.test_session_id)
      }
    })
  }

  it('reports the lines of tests that replace fs, path and timers', async () => {
    const coverageRecords = []
    const testsByName = new Map()
    const coveragePromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcov',
      (payloads) => {
        coverageRecords.length = 0
        coverageRecords.push(...payloads
          .flatMap(({ payload }) => payload)
          .flatMap(({ content: { coverages } }) => coverages))
        assert.ok(coverageRecords.some(({ shared }) => shared === 'init'), 'should report Shared init')
      },
      SUMMARY_TIMEOUT_MS
    )
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        testsByName.clear()
        for (const { payload } of payloads) {
          for (const { type, content } of payload.events) {
            if (type === 'test') testsByName.set(content.meta[TEST_NAME], content)
          }
        }
        assert.strictEqual(testsByName.size, 2)
      },
      SUMMARY_TIMEOUT_MS
    )

    // With Jest's cache on, so that loading a module reads and writes cached instrumented code.
    childProcess = exec(
      'node ./node_modules/jest/bin/jest --config config-jest.js --cache --cacheDirectory=./jest-line-coverage-cache',
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          DD_TEST_LINE_COVERAGE_ENABLED: '1',
          CONFIG_TEST_MATCH: '**/ci-visibility/jest-line-coverage-patches/patched-globals-test.js',
        },
      }
    )
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), coveragePromise, eventsPromise])
    assert.strictEqual(exitCode, 0)

    const linesOf = (name) => {
      const test = testsByName.get(`with replaced fs, path and timers ${name}`)
      assert.ok(test, `no test named ${name}`)
      assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      const record = coverageRecords.find(({ span_id: spanId }) => String(spanId) === String(Number(test.span_id)))
      assert.ok(record, `no record for ${name}`)
      return getLines(record.files, 'ci-visibility/jest-line-coverage-patches/lazy.js')
    }
    // The body of `double`.
    assert.ok(linesOf('runs code loaded while fs and path functions are replaced').has(4))
    assert.ok(linesOf('runs instrumented code with every timer faked').has(4))
  })

  it('reports no per-test or Shared records when line coverage is not requested', async () => {
    const coverageRecords = []
    receiver.on('message', ({ url, payload }) => {
      if (url !== '/api/v2/citestcov') return
      coverageRecords.push(...payload.flatMap(({ content: { coverages } }) => coverages))
    })
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.ok(payloads.length > 0)
      },
      SUMMARY_TIMEOUT_MS
    )

    childProcess = exec('node ./ci-visibility/run-jest.js', {
      cwd,
      env: getCiVisAgentlessConfig(receiver.port),
    })
    await Promise.all([eventsPromise, once(childProcess, 'exit')])

    assert.ok(coverageRecords.length > 0, 'the per-suite coverage is still reported')
    assert.ok(coverageRecords.every(({ span_id: spanId, shared }) => spanId === undefined && shared === undefined))
  })

  it('reports no coverage when the settings do not ask for coverage', async () => {
    receiver.setSettings({ itr_enabled: true, code_coverage: false, tests_skipping: false })
    const coverageRecords = []
    receiver.on('message', ({ url, payload }) => {
      if (url !== '/api/v2/citestcov') return
      coverageRecords.push(...payload.flatMap(({ content: { coverages } }) => coverages))
    })
    const eventsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcycle',
      (payloads) => {
        assert.ok(payloads.length > 0)
      },
      SUMMARY_TIMEOUT_MS
    )

    childProcess = exec('node ./ci-visibility/run-jest.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_TEST_LINE_COVERAGE_ENABLED: '1',
      },
    })
    await Promise.all([eventsPromise, once(childProcess, 'exit')])

    assert.deepStrictEqual(coverageRecords, [])
  })
})
