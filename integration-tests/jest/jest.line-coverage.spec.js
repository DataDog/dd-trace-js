'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { exec } = require('node:child_process')

const { describe, it, before, beforeEach, afterEach } = require('mocha')
const satisfies = require('semifies')

const { assertObjectContains, sandboxCwd, useSandbox, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { TEST_NAME, TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')
const { getBabelDependencies } = require('./babel-dependencies')
const { oldest: oldestJestVersion } = require('./versions')

const requestedJestVersion = process.env.JEST_VERSION || 'latest'
const JEST_VERSION = requestedJestVersion === 'oldest' ? oldestJestVersion : requestedJestVersion

const SUMMARY_TIMEOUT_MS = 30_000
// The parsers a line coverage record can name: none when its process ran only cached code.
const PARSERS = ['oxc-binding', 'oxc-parser', 'meriyah', 'none']

// Jest compiles ECMAScript modules, with Node.js's --experimental-vm-modules, through transformAsync from 27.
const esModuleIt = JEST_VERSION === 'latest' || satisfies(JEST_VERSION, '>=27.0.0') ? it : it.skip

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
        assertObjectContains(PARSERS, [record.parser])
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
        assertObjectContains(PARSERS, [record.parser])
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

  it('reports the initialiser lines a file ran in every module copy by the end of each test', async () => {
    const coverageRecords = []
    const testsByName = new Map()
    const coveragePromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcov',
      (payloads) => {
        coverageRecords.length = 0
        coverageRecords.push(...payloads
          .flatMap(({ payload }) => payload)
          .flatMap(({ content: { coverages } }) => coverages))
        assert.strictEqual(coverageRecords.filter(({ span_id: spanId }) => spanId !== undefined).length, 2)
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

    // In band, so that one process evaluates branches.js once for each test file.
    childProcess = exec('node ./node_modules/jest/bin/jest --config config-jest.js --runInBand', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_TEST_LINE_COVERAGE_ENABLED: '1',
        CONFIG_TEST_MATCH: '**/ci-visibility/jest-line-coverage-copies/*-test.js',
      },
    })
    let testOutput = ''
    childProcess.stdout.on('data', chunk => { testOutput += chunk })
    childProcess.stderr.on('data', chunk => { testOutput += chunk })
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), coveragePromise, eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)

    // The line of branches.js that each test file's copy runs.
    const branchLines = new Map([['runs the first branch', 5], ['runs the second branch', 7]])
    const [earlier, later] = [...branchLines.keys()].map((name) => {
      const test = testsByName.get(`module copies ${name}`)
      assert.ok(test, `no test named ${name}`)
      assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      const record = coverageRecords.find(({ span_id: spanId }) => String(spanId) === String(Number(test.span_id)))
      assert.ok(record, `no record for ${name}`)
      const lines = getLines(record.files, 'ci-visibility/jest-line-coverage-copies/branches.js')
      return { name, start: BigInt(test.start), lines }
    }).sort((a, b) => (a.start < b.start ? -1 : 1))
    // A test gets the body of getBranch, and the initialiser lines branches.js ran in the process by the
    // test's end: those of its own copy, and those of the copies that test files run before it took.
    assert.ok(earlier.lines.has(11) && earlier.lines.has(branchLines.get(earlier.name)), testOutput)
    assert.ok(!earlier.lines.has(branchLines.get(later.name)), testOutput)
    assert.ok(later.lines.has(11) && later.lines.has(5) && later.lines.has(7), testOutput)
  })

  it('names the test file and the modules it mocks in every test record, without lines where it ran none', async () => {
    const coverageRecords = []
    const testsByName = new Map()
    const coveragePromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcov',
      (payloads) => {
        coverageRecords.length = 0
        coverageRecords.push(...payloads
          .flatMap(({ payload }) => payload)
          .flatMap(({ content: { coverages } }) => coverages))
        assert.strictEqual(coverageRecords.filter(({ span_id: spanId }) => spanId !== undefined).length, 2)
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

    childProcess = exec('node ./node_modules/jest/bin/jest --config config-jest.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        DD_TEST_LINE_COVERAGE_ENABLED: '1',
        CONFIG_TEST_MATCH: '**/ci-visibility/jest-line-coverage-dependencies/*-test.js',
      },
    })
    let testOutput = ''
    childProcess.stdout.on('data', chunk => { testOutput += chunk })
    childProcess.stderr.on('data', chunk => { testOutput += chunk })
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), coveragePromise, eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)

    const directory = 'ci-visibility/jest-line-coverage-dependencies'
    const testFile = `${directory}/dependencies-test.js`
    // Named as the per-suite coverage of Test Impact Analysis names a mocked module: the path given to jest.mock.
    const mockedModule = `${directory}/mocked`
    const filesOf = (name) => {
      const test = testsByName.get(`dependencies ${name}`)
      assert.ok(test, `no test named ${name}`)
      assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      const record = coverageRecords.find(({ span_id: spanId }) => String(spanId) === String(Number(test.span_id)))
      assert.ok(record, `no record for ${name}`)
      const filenames = record.files.map(({ filename }) => filename)
      assert.strictEqual(new Set(filenames).size, filenames.length, `a file named twice: ${filenames}`)
      return record.files
    }

    const elsewhere = filesOf('runs a body defined in another file')
    assert.deepStrictEqual(elsewhere.find(({ filename }) => filename === testFile), { filename: testFile })
    assert.deepStrictEqual(elsewhere.find(({ filename }) => filename === mockedModule), { filename: mockedModule })
    assert.ok(getLines(elsewhere, `${directory}/shared-body.js`).size > 0)

    const own = filesOf('runs a line of its own file')
    assert.ok(getLines(own, testFile).size > 0)
    assert.deepStrictEqual(own.find(({ filename }) => filename === mockedModule), { filename: mockedModule })
  })

  esModuleIt('reports the lines each test ran in ECMAScript modules', async () => {
    const coverageRecords = []
    const testsByName = new Map()
    const coveragePromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url === '/api/v2/citestcov',
      (payloads) => {
        coverageRecords.length = 0
        coverageRecords.push(...payloads
          .flatMap(({ payload }) => payload)
          .flatMap(({ content: { coverages } }) => coverages))
        assert.strictEqual(coverageRecords.filter(({ span_id: spanId }) => spanId !== undefined).length, 2)
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

    childProcess = exec('node ./node_modules/jest/bin/jest --config config-jest.js', {
      cwd,
      env: {
        ...getCiVisAgentlessConfig(receiver.port),
        NODE_OPTIONS: '-r dd-trace/ci/init --experimental-vm-modules',
        DD_TEST_LINE_COVERAGE_ENABLED: '1',
        CONFIG_TEST_MATCH: '**/ci-visibility/line-coverage-esm/*.test.mjs',
      },
    })
    let testOutput = ''
    childProcess.stdout.on('data', chunk => { testOutput += chunk })
    childProcess.stderr.on('data', chunk => { testOutput += chunk })
    const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), coveragePromise, eventsPromise])
    assert.strictEqual(exitCode, 0, testOutput)

    const coverageOf = (name) => {
      const test = testsByName.get(`es module arithmetic ${name}`)
      assert.ok(test, `no test named ${name}`)
      assert.strictEqual(test.meta[TEST_STATUS], 'pass')
      const record = coverageRecords.find(({ span_id: spanId }) => String(spanId) === String(Number(test.span_id)))
      assert.ok(record, `no record for ${name}`)
      return record.files
    }
    const adds = coverageOf('adds')
    const multiplies = coverageOf('multiplies')
    const ARITHMETIC = 'ci-visibility/line-coverage-esm/arithmetic.mjs'
    const TESTS = 'ci-visibility/line-coverage-esm/arithmetic.test.mjs'
    // Each test ran its own body and the body of the function it calls, and not the other's.
    assert.ok(getLines(adds, TESTS).has(7))
    assert.ok(getLines(adds, ARITHMETIC).has(2))
    assert.ok(!getLines(adds, ARITHMETIC).has(6))
    assert.ok(getLines(multiplies, TESTS).has(11))
    assert.ok(getLines(multiplies, ARITHMETIC).has(6))
    assert.ok(!getLines(multiplies, ARITHMETIC).has(2))
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
