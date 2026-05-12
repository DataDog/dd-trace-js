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
const {
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_ITR_TESTS_SKIPPED,
  TEST_SKIPPED_BY_ITR,
  TEST_STATUS,
  getLineCoverageBitmap,
  hashCoverageFilePath,
} = require('../../packages/dd-trace/src/plugins/util/test')

const FIXTURE_ROOT = 'ci-visibility/itr-code-coverage'
const SKIPPED_SUITE = `${FIXTURE_ROOT}/test-skipped.js`
const RUN_SOURCE = `${FIXTURE_ROOT}/src/run-dependency.js`
const SKIPPED_SOURCE = `${FIXTURE_ROOT}/src/skipped-dependency.js`
const LINE_PCT_RE = /Lines\s*:\s*(\d+(?:\.\d+)?)%/

function getLinesBitmapBase64 (startLine, endLine) {
  const lineCoverage = {}
  for (let line = startLine; line <= endLine; line++) {
    lineCoverage[line] = 1
  }
  return getLineCoverageBitmap(lineCoverage, true).toString('base64')
}

function getCoverageEvents (payloads) {
  return payloads
    .flatMap(({ payload }) => payload)
    .flatMap(({ content }) => content.coverages)
}

function getLinePctFromOutput (output) {
  const match = output.match(LINE_PCT_RE)
  assert.ok(match, `coverage output did not include a lines percentage:\n${output}`)
  return Number(match[1])
}

const FRAMEWORKS = [
  {
    name: 'mocha',
    skippedSuite: SKIPPED_SUITE,
    command: './node_modules/nyc/bin/nyc.js --all -r=text-summary --nycrc-path ./my-nyc.config.js ' +
      `node node_modules/mocha/bin/mocha ./${FIXTURE_ROOT}/test-*.js`,
    getEnv: () => ({
      NYC_INCLUDE: JSON.stringify([`${FIXTURE_ROOT}/src/**`]),
    }),
  },
  {
    name: 'jest',
    skippedSuite: SKIPPED_SUITE,
    command: 'node ./ci-visibility/run-jest.js',
    getEnv: () => ({
      TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
      COLLECT_COVERAGE_FROM: `${FIXTURE_ROOT}/src/**`,
      ENABLE_CODE_COVERAGE: '1',
      COVERAGE_REPORTERS: 'text-summary',
    }),
  },
]

describe('ITR code coverage', function () {
  let cwd
  let childProcess

  this.timeout(180_000)

  useSandbox(['mocha', 'nyc', 'jest'], true)

  before(() => {
    cwd = sandboxCwd()
  })

  afterEach(() => {
    if (childProcess?.exitCode === null) {
      childProcess.kill()
    }
  })

  async function runFramework ({ framework, suitesToSkip = [] }) {
    const receiver = await new FakeCiVisIntake().start()
    receiver.setSettings({
      itr_enabled: true,
      code_coverage: true,
      tests_skipping: true,
    })
    receiver.setSuitesToSkip(suitesToSkip)

    let eventsResult
    let coverageResult
    let output = ''

    const eventsPromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const skippedSuites = events
          .filter(event => event.type === 'test_suite_end')
          .map(event => event.content)
          .filter(suite => suite.meta[TEST_SKIPPED_BY_ITR] === 'true')

        eventsResult = {
          codeCoverageLinesPct: testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT],
          isItrSkipped: testSession.meta[TEST_ITR_TESTS_SKIPPED],
          skippedSuites,
        }
      })

    const coveragePromise = receiver
      .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
        const coverages = getCoverageEvents(payloads)
        const suiteCoverage = coverages.find(coverage => coverage.test_suite_id)
        const sessionCoverage = coverages.find(coverage => !coverage.test_suite_id)
        const coveredRunSource = coverages
          .flatMap(coverage => coverage.files)
          .find(file => file.filename === RUN_SOURCE)

        assert.ok(suiteCoverage, 'suite code coverage should be reported')
        assert.ok(sessionCoverage, 'session executable-line coverage should be reported')
        assert.ok(coveredRunSource?.bitmap, 'covered files should report line coverage bitmaps')

        coverageResult = coverages
      })

    childProcess = exec(
      framework.command,
      {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          ...framework.getEnv(),
        },
      }
    )
    childProcess.stdout?.on('data', chunk => {
      output += chunk.toString()
    })
    childProcess.stderr?.on('data', chunk => {
      output += chunk.toString()
    })

    try {
      const stdoutEndPromise = childProcess.stdout ? once(childProcess.stdout, 'end') : Promise.resolve()
      const stderrEndPromise = childProcess.stderr ? once(childProcess.stderr, 'end') : Promise.resolve()
      const [, , [exitCode]] = await Promise.all([
        eventsPromise,
        coveragePromise,
        once(childProcess, 'exit'),
        stdoutEndPromise,
        stderrEndPromise,
      ])
      assert.strictEqual(exitCode, 0)

      return {
        ...eventsResult,
        coverages: coverageResult,
        output,
        stdoutCodeCoverageLinesPct: getLinePctFromOutput(output),
      }
    } finally {
      await receiver.stop()
    }
  }

  for (const framework of FRAMEWORKS) {
    it(`keeps ${framework.name} total code coverage stable with skipped coverage`, async () => {
      const baseline = await runFramework({ framework })

      assert.strictEqual(baseline.isItrSkipped, 'false')
      assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.ok(baseline.codeCoverageLinesPct > 0)
      assert.ok(baseline.codeCoverageLinesPct < 100)
      assert.ok(baseline.coverages.length > 0)

      const skippedWithoutCoverage = await runFramework({
        framework,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: framework.skippedSuite,
          },
        }],
      })

      assert.strictEqual(skippedWithoutCoverage.isItrSkipped, 'false')
      assert.strictEqual(skippedWithoutCoverage.skippedSuites.length, 0)
      assert.strictEqual(
        skippedWithoutCoverage.codeCoverageLinesPct,
        skippedWithoutCoverage.stdoutCodeCoverageLinesPct
      )
      assert.strictEqual(skippedWithoutCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)

      const skippedWithCoverage = await runFramework({
        framework,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: framework.skippedSuite,
            coverage: {
              [hashCoverageFilePath(SKIPPED_SOURCE)]: getLinesBitmapBase64(1, 20),
            },
          },
        }],
      })

      assert.strictEqual(skippedWithCoverage.isItrSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(
        skippedWithCoverage.stdoutCodeCoverageLinesPct,
        baseline.stdoutCodeCoverageLinesPct
      )
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    })
  }
})
