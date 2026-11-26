'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { TEST_NAME, TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')
const { getVitestVersions } = require('./versions')

const TEST_FILE = 'ci-visibility/vitest-line-coverage/line-coverage.test.ts'
const PATCHED_GLOBALS_TEST_FILE = 'ci-visibility/vitest-line-coverage/patched-globals.test.ts'
const LAZY = 'ci-visibility/vitest-line-coverage/src/lazy.mjs'
const ARITHMETIC = 'ci-visibility/vitest-line-coverage/src/arithmetic.ts'
const FIXTURE = 'ci-visibility/vitest-line-coverage/src/fixture.mjs'
const ANSWER = 'ci-visibility/vitest-line-coverage/src/answer.mjs'

// Lines of the function bodies in src/arithmetic.ts
const ADD_LINE = 2
const SUBTRACT_LINE = 6
const MULTIPLY_LINE = 10
const DIVIDE_LINE = 14

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

for (const version of getVitestVersions()) {
  describe(`vitest@${version} line coverage`, () => {
    let cwd, receiver, childProcess, testOutput

    useSandbox([
      `vitest@${version}`,
      // Vite 8.3.5's source-map parser rejects the Buffers returned by Vitest's server runner.
      // TODO: remove the pin once Vitest reads cached server modules as UTF-8.
      ...(version === 'latest' ? ['vite@8.3.4'] : []),
    ], true)

    before(() => {
      cwd = sandboxCwd()
    })

    beforeEach(async () => {
      testOutput = ''
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      childProcess?.kill()
      await receiver?.stop()
    })

    /**
     * Runs the fixture suite and returns what the intake received.
     *
     * @param {boolean} isLineCoverageEnabled
     * @param {string} pool
     * @param {boolean} [isCodeCoverageEnabled] whether the settings ask for coverage, which line coverage needs
     * @param {string} [testFile]
     */
    async function runFixtureSuite (isLineCoverageEnabled, pool, isCodeCoverageEnabled = true, testFile = TEST_FILE) {
      receiver.setSettings({ itr_enabled: true, code_coverage: isCodeCoverageEnabled, tests_skipping: false })
      childProcess = exec('./node_modules/.bin/vitest run', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          TEST_DIR: testFile,
          POOL_CONFIG: pool,
          ...(isLineCoverageEnabled ? { DD_TEST_LINE_COVERAGE_ENABLED: '1' } : {}),
        },
      })
      childProcess.stdout.on('data', chunk => { testOutput += chunk })
      childProcess.stderr.on('data', chunk => { testOutput += chunk })

      let payloads
      const gathered = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url === '/api/v2/citestcycle' || url === '/api/v2/citestcov',
        received => { payloads = received },
        { hardTimeout: 60_000 }
      )
      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), gathered])
      assert.strictEqual(exitCode, 0, testOutput)

      const tests = payloads
        .filter(({ url }) => url === '/api/v2/citestcycle')
        .flatMap(({ payload }) => payload.events)
        .filter(event => event.type === 'test')
        .map(({ content }) => content)
      const coverages = payloads
        .filter(({ url }) => url === '/api/v2/citestcov')
        .flatMap(({ payload }) => payload)
        .flatMap(({ content }) => content.coverages)
      return { tests, coverages }
    }

    for (const pool of ['forks', 'threads']) {
      it(`reports the lines each test ran and what ran outside tests (${pool})`, async () => {
        const { tests, coverages } = await runFixtureSuite(true, pool)

        assert.strictEqual(tests.length, 5, testOutput)
        for (const test of tests) assert.strictEqual(test.meta[TEST_STATUS], 'pass', testOutput)

        const coverageOf = name => {
          const test = tests.find(test => test.meta[TEST_NAME].endsWith(name))
          assert.ok(test, `no test named ${name}`)
          const matching = coverages.filter(coverage => coverage.span_id === Number(test.span_id))
          assert.strictEqual(matching.length, 1, `${name}: ${matching.length} records\n${testOutput}`)
          assert.strictEqual(matching[0].test_suite_id, Number(test.parent_id), testOutput)
          return matching[0].files
        }

        // A test gets the lines it ran, in the original TypeScript file, and the suite setup it depends on.
        const adds = coverageOf('adds')
        assert.ok(getLines(adds, ARITHMETIC).has(ADD_LINE), testOutput)
        assert.ok(!getLines(adds, ARITHMETIC).has(SUBTRACT_LINE), testOutput)
        assert.ok(getLines(adds, FIXTURE).has(2), testOutput)

        const subtracts = coverageOf('subtracts')
        assert.ok(getLines(subtracts, ARITHMETIC).has(SUBTRACT_LINE), testOutput)
        assert.ok(!getLines(subtracts, ARITHMETIC).has(ADD_LINE), testOutput)
        assert.ok(getLines(subtracts, FIXTURE).has(2), testOutput)
        // Reading an export runs a getter Vite's module runner added, not code of the module: no line of
        // it, nor its initialiser lines, which a test gets only with other code of the file. Nor line 1,
        // which has no code but is where Vite's statements that define the getters map.
        assert.deepStrictEqual([...getLines(subtracts, ANSWER)], [], testOutput)
        assert.deepStrictEqual([...getLines(adds, ANSWER)].sort((a, b) => a - b), [2, 4, 5], testOutput)

        // The afterEach hook runs after the test's own callback and is part of its window.
        const multiplies = coverageOf('with a per-test hook multiplies')
        assert.ok(getLines(multiplies, ARITHMETIC).has(MULTIPLY_LINE), testOutput)
        assert.ok(getLines(multiplies, FIXTURE).has(6), testOutput)
        assert.ok(!getLines(multiplies, FIXTURE).has(2), testOutput)

        const sharedLines = (part, filename) => {
          const lines = new Set()
          for (const coverage of coverages.filter(coverage => coverage.shared === part)) {
            for (const line of getLines(coverage.files, filename)) lines.add(line)
          }
          return lines
        }
        assert.ok(sharedLines('suiteSetup', FIXTURE).has(2), testOutput)
        assert.ok(!sharedLines('suiteSetup', FIXTURE).has(6), testOutput)
        assert.ok(sharedLines('init', TEST_FILE).size > 0, testOutput)

        // Concurrent tests are covered per test: each gets what it ran, and not what the other ran.
        const divides = coverageOf('divides concurrently')
        assert.ok(getLines(divides, ARITHMETIC).has(DIVIDE_LINE), testOutput)
        assert.ok(!getLines(divides, ARITHMETIC).has(MULTIPLY_LINE), testOutput)
        const multipliesConcurrently = coverageOf('multiplies concurrently')
        assert.ok(getLines(multipliesConcurrently, ARITHMETIC).has(MULTIPLY_LINE), testOutput)
        assert.ok(!getLines(multipliesConcurrently, ARITHMETIC).has(DIVIDE_LINE), testOutput)
      })

      it(`reports the lines of tests that replace fs, path and timers (${pool})`, async () => {
        const { tests, coverages } = await runFixtureSuite(true, pool, true, PATCHED_GLOBALS_TEST_FILE)

        assert.strictEqual(tests.length, 2, testOutput)
        const filesOf = name => {
          const test = tests.find(test => test.meta[TEST_NAME].endsWith(name))
          assert.ok(test, `no test named ${name}`)
          assert.strictEqual(test.meta[TEST_STATUS], 'pass', testOutput)
          const matching = coverages.filter(coverage => coverage.span_id === Number(test.span_id))
          assert.strictEqual(matching.length, 1, `${name}: ${matching.length} records\n${testOutput}`)
          return matching[0].files
        }
        // The body of `double`, loaded while fs and path functions were replaced.
        assert.ok(getLines(filesOf('fs and path functions are replaced'), LAZY).has(2), testOutput)
        assert.ok(getLines(filesOf('with every timer faked'), ARITHMETIC).has(ADD_LINE), testOutput)
      })

      it(`reports the same tests whether or not line coverage is on (${pool})`, async () => {
        const off = await runFixtureSuite(false, pool)
        const on = await runFixtureSuite(true, pool)

        const outcomes = ({ tests }) => tests
          .map(test => `${test.meta[TEST_NAME]}: ${test.meta[TEST_STATUS]}`)
          .sort()
        assert.deepStrictEqual(outcomes(on), outcomes(off))
        // Line coverage takes the place of the per-suite coverage.
        assert.ok(off.coverages.length > 0, testOutput)
        assert.ok(off.coverages.every(coverage => coverage.span_id === undefined), testOutput)
        assert.ok(on.coverages.some(coverage => coverage.span_id !== undefined), testOutput)
        assert.ok(
          on.coverages.every(coverage => coverage.span_id !== undefined || coverage.shared !== undefined),
          testOutput
        )
      })
    }

    it('collects no coverage when the settings do not ask for coverage', async () => {
      const { tests, coverages } = await runFixtureSuite(true, 'forks', false)

      assert.strictEqual(tests.length, 5, testOutput)
      assert.deepStrictEqual(coverages, [], testOutput)
    })
  })
}
