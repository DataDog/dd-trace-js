'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  assertObjectContains,
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { TEST_NAME, TEST_STATUS } = require('../../packages/dd-trace/src/plugins/util/test')
const { getVitestVersions } = require('./versions')

const TEST_FILE = 'ci-visibility/vitest-line-coverage/line-coverage.test.ts'
const PATCHED_GLOBALS_TEST_FILE = 'ci-visibility/vitest-line-coverage/patched-globals.test.ts'
const DEPENDENCIES_TEST_FILE = 'ci-visibility/vitest-line-coverage/dependencies.test.ts'
const SETTINGS = 'ci-visibility/vitest-line-coverage/src/settings.json'
const LAZY_SETTINGS = 'ci-visibility/vitest-line-coverage/src/lazy-settings.json'
const NO_CODE = 'ci-visibility/vitest-line-coverage/src/no-code.mjs'
const LAZY_NO_CODE = 'ci-visibility/vitest-line-coverage/src/lazy-no-code.mjs'
const LAZY = 'ci-visibility/vitest-line-coverage/src/lazy.mjs'
const ARITHMETIC = 'ci-visibility/vitest-line-coverage/src/arithmetic.ts'
const FIXTURE = 'ci-visibility/vitest-line-coverage/src/fixture.mjs'
const ANSWER = 'ci-visibility/vitest-line-coverage/src/answer.mjs'
const FILE_HOOKS_TEST_FILES = 'ci-visibility/vitest-line-coverage/*file-hooks.test.ts'
const HOOKS = 'ci-visibility/vitest-line-coverage/src/hooks.mjs'

// Lines of the function bodies in src/arithmetic.ts
const ADD_LINE = 2
const SUBTRACT_LINE = 6
const MULTIPLY_LINE = 10
const DIVIDE_LINE = 14

// Lines of the function bodies in src/hooks.mjs, one per hook of file-hooks.test.ts and one for its tests
const BEFORE_ALL_LINE = 2
const BEFORE_EACH_LINE = 6
const AFTER_EACH_LINE = 10
const AFTER_ALL_LINE = 14
const IN_TEST_LINE = 18

// The parsers a line coverage record can name: none when its process ran only cached code.
const PARSERS = ['oxc-binding', 'oxc-parser', 'meriyah', 'none']

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

/**
 * @param {{ shared?: string, files: { filename: string, bitmap?: Uint8Array }[] }[]} coverages
 * @param {string} part the part of Shared: init, suiteSetup or unowned
 * @param {string} filename
 * @returns {Set<number>}
 */
function getSharedLines (coverages, part, filename) {
  const lines = new Set()
  for (const coverage of coverages.filter(coverage => coverage.shared === part)) {
    for (const line of getLines(coverage.files, filename)) lines.add(line)
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

        assert.strictEqual(tests.length, 7, testOutput)
        for (const test of tests) {
          const isSkipped = test.meta[TEST_NAME].includes('skipped tests')
          assert.strictEqual(test.meta[TEST_STATUS], isSkipped ? 'skip' : 'pass', testOutput)
        }

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

        assert.ok(getSharedLines(coverages, 'suiteSetup', FIXTURE).has(2), testOutput)
        assert.ok(!getSharedLines(coverages, 'suiteSetup', FIXTURE).has(6), testOutput)
        assert.ok(getSharedLines(coverages, 'init', TEST_FILE).size > 0, testOutput)

        // Concurrent tests are covered per test: each gets what it ran, and not what the other ran.
        const divides = coverageOf('divides concurrently')
        assert.ok(getLines(divides, ARITHMETIC).has(DIVIDE_LINE), testOutput)
        assert.ok(!getLines(divides, ARITHMETIC).has(MULTIPLY_LINE), testOutput)
        const multipliesConcurrently = coverageOf('multiplies concurrently')
        assert.ok(getLines(multipliesConcurrently, ARITHMETIC).has(MULTIPLY_LINE), testOutput)
        assert.ok(!getLines(multipliesConcurrently, ARITHMETIC).has(DIVIDE_LINE), testOutput)

        // A test that skips itself gets what ran before it did; one skipped before it starts ran nothing.
        assert.ok(getLines(coverageOf('skips itself after it starts'), ARITHMETIC).has(SUBTRACT_LINE), testOutput)
        const skippedBeforeStart = tests.find(test => test.meta[TEST_NAME].endsWith('is skipped before it starts'))
        assert.ok(skippedBeforeStart, testOutput)
        assert.ok(!coverages.some(coverage => coverage.span_id === Number(skippedBeforeStart.span_id)), testOutput)

        // Each record names the parser of the worker that sent it.
        const lineRecords = coverages.filter(coverage => coverage.span_id !== undefined || coverage.shared)
        assert.ok(lineRecords.length > 0, testOutput)
        for (const coverage of lineRecords) assertObjectContains(PARSERS, [coverage.parser])
      })

      it(`reports the lines of hooks declared at a file's top level (${pool})`, async () => {
        const { tests, coverages } = await runFixtureSuite(true, pool, true, FILE_HOOKS_TEST_FILES)

        assert.strictEqual(tests.length, 3, testOutput)
        const linesOf = name => {
          const test = tests.find(test => test.meta[TEST_NAME].endsWith(name))
          assert.ok(test, `no test named ${name}`)
          assert.strictEqual(test.meta[TEST_STATUS], 'pass', testOutput)
          const matching = coverages.filter(coverage => coverage.span_id === Number(test.span_id))
          assert.strictEqual(matching.length, 1, `${name}: ${matching.length} records\n${testOutput}`)
          return getLines(matching[0].files, HOOKS)
        }

        // A test of the file gets its own lines, the file's beforeEach and afterEach, which are part of its
        // window, and the file's beforeAll, as suite setup. Its own lines must survive the beforeEach running
        // the same module first.
        for (const name of ['runs inside a describe block', 'runs at the top level']) {
          const lines = linesOf(name)
          for (const line of [IN_TEST_LINE, BEFORE_EACH_LINE, AFTER_EACH_LINE, BEFORE_ALL_LINE]) {
            assert.ok(lines.has(line), `${name}: no line ${line} of src/hooks.mjs\n${testOutput}`)
          }
          assert.ok(!lines.has(AFTER_ALL_LINE), testOutput)
        }
        const withoutHooks = linesOf('runs in a file without hooks')
        assert.ok(withoutHooks.has(IN_TEST_LINE), testOutput)
        for (const line of [BEFORE_ALL_LINE, BEFORE_EACH_LINE, AFTER_EACH_LINE, AFTER_ALL_LINE]) {
          assert.ok(!withoutHooks.has(line), `line ${line} of src/hooks.mjs\n${testOutput}`)
        }

        // The file's afterAll runs after its tests, in no test's window: only Shared has it.
        assert.ok(getSharedLines(coverages, 'unowned', HOOKS).has(AFTER_ALL_LINE), testOutput)
        assert.ok(getSharedLines(coverages, 'suiteSetup', HOOKS).has(BEFORE_ALL_LINE), testOutput)
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

      it(`names the files a test depends on without lines where it ran none (${pool})`, async () => {
        const { tests, coverages } = await runFixtureSuite(true, pool, true, DEPENDENCIES_TEST_FILE)

        assert.strictEqual(tests.length, 3, testOutput)
        const filesOf = name => {
          const test = tests.find(test => test.meta[TEST_NAME].endsWith(name))
          assert.ok(test, `no test named ${name}`)
          assert.strictEqual(test.meta[TEST_STATUS], 'pass', testOutput)
          const matching = coverages.filter(coverage => coverage.span_id === Number(test.span_id))
          assert.strictEqual(matching.length, 1, `${name}: ${matching.length} records\n${testOutput}`)
          const filenames = matching[0].files.map(({ filename }) => filename)
          assert.strictEqual(new Set(filenames).size, filenames.length, `a file named twice: ${filenames}`)
          return matching[0].files
        }

        const elsewhere = filesOf('runs a body defined in another file')
        const testFileEntry = elsewhere.find(({ filename }) => filename === DEPENDENCIES_TEST_FILE)
        assert.deepStrictEqual(testFileEntry, { filename: DEPENDENCIES_TEST_FILE }, testOutput)
        assert.ok(getLines(elsewhere, ARITHMETIC).has(ADD_LINE), testOutput)

        assert.ok(getLines(filesOf('runs a line of its own file'), DEPENDENCIES_TEST_FILE).size > 0, testOutput)

        // A module with no line of code, imported while the test file loads, is in Shared init without lines.
        // Imported inside a test, it is in no record: only the first test to import it evaluates it.
        const initFiles = coverages.filter(({ shared }) => shared === 'init').flatMap(({ files }) => files)
        const noCodeEntry = initFiles.find(({ filename }) => filename === NO_CODE)
        assert.deepStrictEqual(noCodeEntry, { filename: NO_CODE }, testOutput)
        const importsOne = filesOf('imports a module of no code')
        assert.ok(getLines(importsOne, DEPENDENCIES_TEST_FILE).size > 0, testOutput)
        assert.ok(!coverages.some(({ files }) => files.some(({ filename }) => filename === LAZY_NO_CODE)), testOutput)

        // In some Vitest versions a JSON module has lines that map to its file, in others it has none. Either way
        // it has no code outside its initialiser, so no test record names it.
        assert.ok(initFiles.some(({ filename }) => filename === SETTINGS), testOutput)
        const recordFiles = coverages.filter(({ shared }) => shared === undefined).flatMap(({ files }) => files)
        assert.ok(!recordFiles.some(({ filename }) => filename === SETTINGS || filename === LAZY_SETTINGS), testOutput)
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

      assert.strictEqual(tests.length, 7, testOutput)
      assert.deepStrictEqual(coverages, [], testOutput)
    })
  })
}
