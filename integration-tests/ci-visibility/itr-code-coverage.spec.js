'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { inspect } = require('node:util')

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
const RUN_SUITE = `${FIXTURE_ROOT}/test-run.js`
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
    name: 'jest',
    skippedSuite: SKIPPED_SUITE,
    command: 'node ./ci-visibility/run-jest.js',
    getEnv: () => ({
      TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
      TEST_BUNDLE: FIXTURE_ROOT,
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

  useSandbox(['jest'], true)

  before(() => {
    cwd = sandboxCwd()
  })

  afterEach(() => {
    if (childProcess?.exitCode === null) {
      childProcess.kill()
    }
  })

  async function runFramework ({ framework, suitesToSkip = [], assertSkippableRequest }) {
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
        const testSessionEvent = events.find(event => event.type === 'test_session_end')
        assert.ok(testSessionEvent, `test session event should be reported:\n${output}`)
        const testSession = testSessionEvent.content
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

        assert.ok(suiteCoverage, `suite code coverage should be reported:\n${output}`)
        assert.ok(sessionCoverage, `session executable-line coverage should be reported:\n${output}`)
        assert.ok(coveredRunSource?.bitmap, `covered files should report line coverage bitmaps:\n${output}`)

        coverageResult = coverages
      })
    const skippableRequestPromise = assertSkippableRequest
      ? receiver
        .payloadReceived(({ url }) => url === '/api/v2/ci/tests/skippable')
        .then(request => assertSkippableRequest(request, () => output))
      : Promise.resolve()

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
        skippableRequestPromise,
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
      assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)
      assert.ok(baseline.codeCoverageLinesPct < 100, `baseline coverage was ${baseline.codeCoverageLinesPct}`)
      assert.ok(baseline.coverages.length > 0, 'baseline should report coverage payloads')

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
              [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
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

  it('keeps jest total code coverage stable when all suites are skippable with collectCoverageFrom', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        COLLECT_COVERAGE_FROM: `${FIXTURE_ROOT}/src/**`,
        ENABLE_CODE_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
        USE_JEST_RUN: '1',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const skippedWithCoverage = await runFramework({
      framework,
      assertSkippableRequest: (request, getOutput) => {
        assert.strictEqual(
          request.payload.data.attributes.configurations['test.bundle'],
          FIXTURE_ROOT,
          `${inspect(request.payload, { depth: 5 })}\n${getOutput()}`
        )
      },
      suitesToSkip: [
        {
          type: 'suite',
          attributes: {
            suite: RUN_SUITE,
            coverage: {
              [RUN_SOURCE]: coveredSkippedLines,
            },
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
            coverage: {
              [SKIPPED_SOURCE]: coveredSkippedLines,
            },
          },
        },
      ],
    })

    assert.strictEqual(skippedWithCoverage.isItrSkipped, 'true')
    assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
    assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
  })

  it('keeps jest config-file coverage stable when collectCoverageFrom is missing', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        CONFIG_TEST_MATCH: `**/${FIXTURE_ROOT}/test-*.js`,
        CONFIG_COLLECT_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
        USE_CONFIG_FILE: '1',
        USE_JEST_RUN: '1',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const skippedCoverage = await runFramework({
      framework,
      assertSkippableRequest: (request, getOutput) => {
        assert.strictEqual(
          request.payload.data.attributes.configurations['test.bundle'],
          FIXTURE_ROOT,
          `${inspect(request.payload, { depth: 5 })}\n${getOutput()}`
        )
      },
      suitesToSkip: [
        {
          type: 'suite',
          attributes: {
            suite: RUN_SUITE,
            coverage: {
              [RUN_SOURCE]: coveredSkippedLines,
            },
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
            coverage: {
              [SKIPPED_SOURCE]: coveredSkippedLines,
            },
          },
        },
      ],
    })

    assert.strictEqual(skippedCoverage.isItrSkipped, 'true')
    assert.strictEqual(skippedCoverage.skippedSuites.length, 1)
    assert.strictEqual(skippedCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
    assert.strictEqual(skippedCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.strictEqual(skippedCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
  })

  it('keeps jest coverage stable when the backend response includes suites outside the local run', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        COLLECT_COVERAGE_FROM: `${FIXTURE_ROOT}/src/**`,
        ENABLE_CODE_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
        USE_JEST_RUN: '1',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const broaderCoverage = await runFramework({
      framework,
      assertSkippableRequest: (request, getOutput) => {
        assert.strictEqual(
          request.payload.data.attributes.configurations['test.bundle'],
          FIXTURE_ROOT,
          `${inspect(request.payload, { depth: 5 })}\n${getOutput()}`
        )
      },
      suitesToSkip: [
        {
          type: 'suite',
          attributes: {
            suite: RUN_SUITE,
            coverage: {
              [RUN_SOURCE]: coveredSkippedLines,
            },
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
            coverage: {
              [SKIPPED_SOURCE]: coveredSkippedLines,
            },
          },
        },
        {
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/other-suite/test-outside-local-run.js',
            coverage: {
              'ci-visibility/other-suite/src/outside-local-run.js': coveredSkippedLines,
            },
          },
        },
      ],
    })

    assert.strictEqual(broaderCoverage.isItrSkipped, 'true')
    assert.strictEqual(broaderCoverage.skippedSuites.length, 1)
    assert.strictEqual(broaderCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
    assert.strictEqual(broaderCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.strictEqual(broaderCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
  })

  it('skips when scoped hash coverage cannot be seeded in Jest stdout', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        TEST_BUNDLE: FIXTURE_ROOT,
        ENABLE_CODE_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const unseedableCoverage = await runFramework({
      framework,
      suitesToSkip: [{
        type: 'suite',
        attributes: {
          suite: SKIPPED_SUITE,
          coverage: {
            [hashCoverageFilePath(SKIPPED_SOURCE)]: coveredSkippedLines,
          },
        },
      }],
    })

    assert.strictEqual(unseedableCoverage.isItrSkipped, 'true')
    assert.strictEqual(unseedableCoverage.skippedSuites.length, 1)
    assert.strictEqual(unseedableCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
  })

  it('skips when unscoped hash coverage cannot be seeded in Jest stdout', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        ENABLE_CODE_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const unseedableCoverage = await runFramework({
      framework,
      suitesToSkip: [{
        type: 'suite',
        attributes: {
          suite: SKIPPED_SUITE,
          coverage: {
            [SKIPPED_SOURCE]: coveredSkippedLines,
          },
        },
      }],
    })

    assert.strictEqual(unseedableCoverage.isItrSkipped, 'true')
    assert.strictEqual(unseedableCoverage.skippedSuites.length, 1)
    assert.strictEqual(unseedableCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
  })

  it('keeps jest coverage stable when a cli pattern is not a bundle path', async () => {
    const framework = {
      ...FRAMEWORKS[0],
      command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}/test-`,
      getEnv: () => ({
        TESTS_TO_RUN: `${FIXTURE_ROOT}/test-`,
        ENABLE_CODE_COVERAGE: '1',
        COVERAGE_REPORTERS: 'text-summary',
        USE_JEST_RUN: '1',
      }),
    }
    const baseline = await runFramework({ framework })

    assert.strictEqual(baseline.isItrSkipped, 'false')
    assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

    const coveredSkippedLines = getLinesBitmapBase64(1, 20)
    const unscopedPatternRun = await runFramework({
      framework,
      assertSkippableRequest: (request, getOutput) => {
        assert.strictEqual(
          request.payload.data.attributes.configurations['test.bundle'],
          'jest',
          `${inspect(request.payload, { depth: 5 })}\n${getOutput()}`
        )
      },
      suitesToSkip: [{
        type: 'suite',
        attributes: {
          suite: SKIPPED_SUITE,
          coverage: {
            [SKIPPED_SOURCE]: coveredSkippedLines,
          },
        },
      }],
    })

    assert.strictEqual(unscopedPatternRun.isItrSkipped, 'true')
    assert.strictEqual(unscopedPatternRun.skippedSuites.length, 1)
    assert.strictEqual(unscopedPatternRun.skippedSuites[0].meta[TEST_STATUS], 'skip')
    assert.strictEqual(unscopedPatternRun.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
    assert.strictEqual(unscopedPatternRun.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
  })
})
