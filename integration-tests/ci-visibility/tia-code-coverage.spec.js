'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')

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
} = require('../../packages/dd-trace/src/plugins/util/test')

const FIXTURE_ROOT = 'ci-visibility/tia-code-coverage'
const RUN_SUITE = `${FIXTURE_ROOT}/test-run.js`
const SKIPPED_SUITE = `${FIXTURE_ROOT}/test-skipped.js`
const RUN_SOURCE = `${FIXTURE_ROOT}/src/run-dependency.js`
const SKIPPED_SOURCE = `${FIXTURE_ROOT}/src/skipped-dependency.js`
const EXTRA_SOURCE = `${FIXTURE_ROOT}/src/uncovered-dependency.js`
const DEFAULT_COLLECT_COVERAGE_FROM = `${FIXTURE_ROOT}/src/**`
const LINE_PCT_RE = /Lines\s*:\s*(\d+(?:\.\d+)?)%/
const MINIMUM_SUPPORTED_JEST_VERSION = '28.0.0'

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

function getJestEnv ({
  testsToRun = `${FIXTURE_ROOT}/test-`,
  collectCoverageFrom = DEFAULT_COLLECT_COVERAGE_FROM,
  useJestRun = false,
  useConfigFile = false,
  configTestMatch,
  configCollectCoverage = false,
  configTransform,
} = {}) {
  const env = {
    TESTS_TO_RUN: testsToRun,
    ENABLE_CODE_COVERAGE: '1',
    COVERAGE_REPORTERS: 'text-summary',
  }

  if (collectCoverageFrom !== null) {
    env.COLLECT_COVERAGE_FROM = collectCoverageFrom
  }
  if (useJestRun) {
    env.USE_JEST_RUN = '1'
  }
  if (useConfigFile) {
    env.USE_CONFIG_FILE = '1'
  }
  if (configTestMatch) {
    env.CONFIG_TEST_MATCH = configTestMatch
  }
  if (configCollectCoverage) {
    env.CONFIG_COLLECT_COVERAGE = '1'
  }
  if (configTransform) {
    env.CONFIG_TRANSFORM = JSON.stringify(configTransform)
  }

  return env
}

const FRAMEWORKS = [
  {
    name: 'jest',
    skippedSuite: SKIPPED_SUITE,
    command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
    getEnv: () => getJestEnv(),
  },
]

const JEST_VERSION_CONFIGS = [
  {
    version: 'latest',
    dependencies: ['jest'],
  },
  {
    version: MINIMUM_SUPPORTED_JEST_VERSION,
    dependencies: [
      `jest@${MINIMUM_SUPPORTED_JEST_VERSION}`,
      `jest-circus@${MINIMUM_SUPPORTED_JEST_VERSION}`,
    ],
  },
]

function describeJestVersion (jestVersion, dependencies) {
  describe(`TIA code coverage jest@${jestVersion}`, function () {
    let cwd
    let childProcess

    this.timeout(180_000)

    useSandbox(dependencies, true)

    before(() => {
      cwd = sandboxCwd()
    })

    afterEach(() => {
      if (childProcess?.exitCode === null) {
        childProcess.kill()
      }
    })

    async function runFramework ({
      framework,
      suitesToSkip = [],
      skippableCoverage = {},
      settings = {
        itr_enabled: true,
        code_coverage: true,
        tests_skipping: true,
      },
      expectSuiteCoverage = true,
      expectSessionCoverage = true,
    }) {
      const receiver = await new FakeCiVisIntake().start()
      receiver.setSettings(settings)
      receiver.setSuitesToSkip(suitesToSkip)
      receiver.setSkippableCoverage(skippableCoverage)

      let eventsResult
      let coverageResult
      let output = ''
      let receivedSkippableRequest = false
      const skippableRequestListener = ({ url }) => {
        if (url.endsWith('/api/v2/ci/tests/skippable')) {
          receivedSkippableRequest = true
        }
      }
      receiver.on('message', skippableRequestListener)

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
            isTiaSkipped: testSession.meta[TEST_ITR_TESTS_SKIPPED],
            skippedSuites,
          }
        })

      const coveragePromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
          const coverages = getCoverageEvents(payloads)
          const suiteCoverage = coverages.find(coverage => coverage.test_suite_id)
          const sessionCoverage = coverages.find(coverage => !coverage.test_suite_id)
          const coveredFile = coverages
            .flatMap(coverage => coverage.files)
            .find(file => file.bitmap)

          if (expectSuiteCoverage) {
            assert.ok(suiteCoverage, `suite code coverage should be reported:\n${output}`)
          } else {
            assert.strictEqual(suiteCoverage, undefined, `suite code coverage should not be reported:\n${output}`)
          }
          if (expectSessionCoverage) {
            assert.ok(sessionCoverage, `session executable-line coverage should be reported:\n${output}`)
          } else {
            assert.strictEqual(
              sessionCoverage,
              undefined,
            `session executable-line coverage should not be reported:\n${output}`
            )
          }
          assert.ok(coveredFile?.bitmap, `covered files should report line coverage bitmaps:\n${output}`)

          coverageResult = coverages
        })
      childProcess = exec(
        framework.command,
        {
          cwd: framework.cwd ? framework.cwd(cwd) : cwd,
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
          receivedSkippableRequest,
          stdoutCodeCoverageLinesPct: getLinePctFromOutput(output),
        }
      } finally {
        receiver.off('message', skippableRequestListener)
        await receiver.stop()
      }
    }

    for (const framework of FRAMEWORKS) {
    // Mixed local run: one suite still executes and one suite is skipped. Without backend coverage the total
    // drops; with meta.coverage backfill, both Jest stdout and the Datadog session metric return to baseline.
      it(`keeps ${framework.name} total code coverage stable with skipped coverage`, async () => {
        const baseline = await runFramework({ framework })

        assert.strictEqual(baseline.isTiaSkipped, 'false')
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

        assert.strictEqual(skippedWithoutCoverage.isTiaSkipped, 'true')
        assert.strictEqual(skippedWithoutCoverage.skippedSuites.length, 1)
        assert.strictEqual(skippedWithoutCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
        assert.strictEqual(
          skippedWithoutCoverage.codeCoverageLinesPct,
          skippedWithoutCoverage.stdoutCodeCoverageLinesPct
        )
        assert.ok(
          skippedWithoutCoverage.codeCoverageLinesPct < baseline.codeCoverageLinesPct,
        `expected ${skippedWithoutCoverage.codeCoverageLinesPct} to be lower than ${baseline.codeCoverageLinesPct}`
        )

        const skippedWithCoverage = await runFramework({
          framework,
          suitesToSkip: [{
            type: 'suite',
            attributes: {
              suite: framework.skippedSuite,
            },
          }],
          skippableCoverage: {
            [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
          },
        })

        assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
        assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
        assert.strictEqual(skippedWithCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
        assert.strictEqual(
          skippedWithCoverage.stdoutCodeCoverageLinesPct,
          baseline.stdoutCodeCoverageLinesPct
        )
        assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      })
    }

    // If suite skipping is disabled, a skippable response with meta.coverage must not alter the run. We compare
    // against a no-skipping baseline, not just stdout vs. Datadog, to catch accidental backfill side effects.
    it('does not alter jest coverage when suite skipping is disabled', async () => {
      const framework = FRAMEWORKS[0]
      const baseline = await runFramework({ framework })
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      const result = await runFramework({
        framework,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: coveredSkippedLines,
        },
        settings: {
          itr_enabled: true,
          code_coverage: true,
          tests_skipping: false,
        },
      })

      assert.notStrictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedSuites.length, 0)
      assert.strictEqual(result.codeCoverageLinesPct, result.stdoutCodeCoverageLinesPct)
      assert.strictEqual(result.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(result.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })

    // Session-level executable coverage is only needed for TIA flows. When TIA is off, ordinary Jest coverage should
    // not pay the extra coverage-map walk or send the extra CITESTCOV request.
    it('does not report jest session coverage when TIA is disabled', async () => {
      const result = await runFramework({
        framework: FRAMEWORKS[0],
        settings: {
          itr_enabled: false,
          code_coverage: true,
          tests_skipping: false,
        },
        expectSessionCoverage: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'false')
      assert.strictEqual(result.skippedSuites.length, 0)
      assert.strictEqual(result.codeCoverageLinesPct, result.stdoutCodeCoverageLinesPct)
    })

    // TIA is the top-level gate for suite skipping. Even if a malformed settings response has tests_skipping=true,
    // disabling TIA must avoid the skippable request and leave ordinary Jest coverage untouched.
    it('does not request skippable suites or backfill coverage when TIA is disabled', async () => {
      const framework = FRAMEWORKS[0]
      const baseline = await runFramework({ framework })
      const result = await runFramework({
        framework,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
        },
        settings: {
          itr_enabled: false,
          code_coverage: true,
          tests_skipping: true,
        },
        expectSessionCoverage: false,
      })

      assert.strictEqual(result.receivedSkippableRequest, false)
      assert.strictEqual(result.isTiaSkipped, 'false')
      assert.strictEqual(result.skippedSuites.length, 0)
      assert.strictEqual(result.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(result.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })

    // Zero-local-suite path: every suite that Jest would run is returned as skippable. No suite should run here;
    // instead, we synthesize the Jest coverage report from backend meta.coverage and the local Jest config.
    it('keeps jest total code coverage stable when all local suites are skippable', async () => {
      const framework = {
        ...FRAMEWORKS[0],
        command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
        getEnv: () => getJestEnv({ useJestRun: true }),
      }
      const baseline = await runFramework({ framework })

      assert.strictEqual(baseline.isTiaSkipped, 'false')
      assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      const skippedWithCoverage = await runFramework({
        framework,
        suitesToSkip: [
          {
            type: 'suite',
            attributes: {
              suite: RUN_SUITE,
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: SKIPPED_SUITE,
            },
          },
        ],
        skippableCoverage: {
          [RUN_SOURCE]: coveredSkippedLines,
          [SKIPPED_SOURCE]: coveredSkippedLines,
        },
        expectSuiteCoverage: false,
      })

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 2)
      assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })

    // The backend returns aggregate meta.coverage for the skippable response, which can include suites outside this
    // local Jest invocation. We apply that coverage as the session base because commit-level aggregation is the
    // product target, even if a single shard/session reports broader coverage than it locally executed.
    it('uses backend coverage outside the local run as the jest coverage base', async () => {
      const framework = {
        ...FRAMEWORKS[0],
        command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
        getEnv: () => getJestEnv({ useJestRun: true }),
      }
      const baseline = await runFramework({ framework })

      assert.strictEqual(baseline.isTiaSkipped, 'false')
      assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      const broaderCoverage = await runFramework({
        framework,
        suitesToSkip: [
          {
            type: 'suite',
            attributes: {
              suite: RUN_SUITE,
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: SKIPPED_SUITE,
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/other-suite/test-outside-local-run.js',
            },
          },
        ],
        skippableCoverage: {
          [RUN_SOURCE]: coveredSkippedLines,
          [SKIPPED_SOURCE]: coveredSkippedLines,
          [EXTRA_SOURCE]: coveredSkippedLines,
        },
        expectSuiteCoverage: false,
      })

      assert.strictEqual(broaderCoverage.isTiaSkipped, 'true')
      assert.strictEqual(broaderCoverage.skippedSuites.length, 2)
      assert.strictEqual(broaderCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.ok(
        broaderCoverage.stdoutCodeCoverageLinesPct > baseline.stdoutCodeCoverageLinesPct,
      `expected ${broaderCoverage.stdoutCodeCoverageLinesPct} to be higher than ` +
        `${baseline.stdoutCodeCoverageLinesPct}`
      )
      assert.ok(
        broaderCoverage.codeCoverageLinesPct > baseline.codeCoverageLinesPct,
      `expected ${broaderCoverage.codeCoverageLinesPct} to be higher than ${baseline.codeCoverageLinesPct}`
      )
      assert.strictEqual(broaderCoverage.stdoutCodeCoverageLinesPct, 100)
      assert.strictEqual(broaderCoverage.codeCoverageLinesPct, 100)
    })

    // Some custom coverage transformers, including SWC-based setups, emit Istanbul metadata as a plain
    // `var coverageData = ...` literal. That shape is not parsed by Istanbul's readInitialCoverage(), but we still
    // need it when no local suite runs and backend meta.coverage is the only covered-line source.
    it('backfills jest coverage from transformer coverageData literals', async () => {
      const framework = {
        ...FRAMEWORKS[0],
        command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
        getEnv: () => getJestEnv({
          collectCoverageFrom: null,
          configTestMatch: `**/${FIXTURE_ROOT}/test-*.js`,
          configCollectCoverage: true,
          configTransform: {
            '^.+\\.js$': `<rootDir>/${FIXTURE_ROOT}/coverage-data-transformer.js`,
          },
          useConfigFile: true,
          useJestRun: true,
        }),
      }
      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      const result = await runFramework({
        framework,
        suitesToSkip: [
          {
            type: 'suite',
            attributes: {
              suite: RUN_SUITE,
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: SKIPPED_SUITE,
            },
          },
        ],
        skippableCoverage: {
          [RUN_SOURCE]: coveredSkippedLines,
          [SKIPPED_SOURCE]: coveredSkippedLines,
        },
        expectSuiteCoverage: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedSuites.length, 2)
      assert.strictEqual(result.stdoutCodeCoverageLinesPct, 100)
      assert.strictEqual(result.codeCoverageLinesPct, 100)
    })

    // Customers can enable Jest coverage without collectCoverageFrom. These cases keep that absence explicit so we
    // do not accidentally make TIA coverage backfill depend on users configuring collection globs.
    context('without collectCoverageFrom', () => {
    // Config-file coverage still has enough Jest coverage machinery to publish totals. Backend coverage fills the
    // skipped files and keeps the result aligned with the baseline without running a suite.
      it('keeps jest config-file coverage stable', async () => {
        const framework = {
          ...FRAMEWORKS[0],
          command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}`,
          getEnv: () => getJestEnv({
            collectCoverageFrom: null,
            configTestMatch: `**/${FIXTURE_ROOT}/test-*.js`,
            configCollectCoverage: true,
            useConfigFile: true,
            useJestRun: true,
          }),
        }
        const baseline = await runFramework({ framework })

        assert.strictEqual(baseline.isTiaSkipped, 'false')
        assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
        assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

        const coveredSkippedLines = getLinesBitmapBase64(1, 20)
        const skippedCoverage = await runFramework({
          framework,
          suitesToSkip: [
            {
              type: 'suite',
              attributes: {
                suite: RUN_SUITE,
              },
            },
            {
              type: 'suite',
              attributes: {
                suite: SKIPPED_SUITE,
              },
            },
          ],
          skippableCoverage: {
            [RUN_SOURCE]: coveredSkippedLines,
            [SKIPPED_SOURCE]: coveredSkippedLines,
          },
          expectSuiteCoverage: false,
        })

        assert.strictEqual(skippedCoverage.isTiaSkipped, 'true')
        assert.strictEqual(skippedCoverage.skippedSuites.length, 2)
        assert.strictEqual(skippedCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
        assert.strictEqual(skippedCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
        assert.strictEqual(skippedCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
      })

      // Missing collectCoverageFrom should not block the skip decision when backend line coverage is present. This
      // mainly guards against treating the absence of a user glob as "unsafe to skip."
      it('skips when backend coverage is available', async () => {
        const framework = {
          ...FRAMEWORKS[0],
          getEnv: () => getJestEnv({ collectCoverageFrom: null }),
        }
        const baseline = await runFramework({ framework })

        assert.strictEqual(baseline.isTiaSkipped, 'false')
        assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
        assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

        const coveredSkippedLines = getLinesBitmapBase64(1, 20)
        const unseedableCoverage = await runFramework({
          framework,
          suitesToSkip: [{
            type: 'suite',
            attributes: {
              suite: SKIPPED_SUITE,
            },
          }],
          skippableCoverage: {
            [SKIPPED_SOURCE]: coveredSkippedLines,
          },
        })

        assert.strictEqual(unseedableCoverage.isTiaSkipped, 'true')
        assert.strictEqual(unseedableCoverage.skippedSuites.length, 1)
        assert.strictEqual(unseedableCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      })

      // A CLI test pattern can be a prefix or regex-like value rather than a directory. Backend file paths still give
      // us the files to seed, so coverage should stay stable after skipping.
      it('keeps jest coverage stable when a cli pattern is not a directory path', async () => {
        const framework = {
          ...FRAMEWORKS[0],
          command: `node ./ci-visibility/run-jest.js ${FIXTURE_ROOT}/test-`,
          getEnv: () => getJestEnv({
            collectCoverageFrom: null,
            useJestRun: true,
          }),
        }
        const baseline = await runFramework({ framework })

        assert.strictEqual(baseline.isTiaSkipped, 'false')
        assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
        assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)

        const coveredSkippedLines = getLinesBitmapBase64(1, 20)
        const unscopedPatternRun = await runFramework({
          framework,
          suitesToSkip: [{
            type: 'suite',
            attributes: {
              suite: SKIPPED_SUITE,
            },
          }],
          skippableCoverage: {
            [SKIPPED_SOURCE]: coveredSkippedLines,
          },
        })

        assert.strictEqual(unscopedPatternRun.isTiaSkipped, 'true')
        assert.strictEqual(unscopedPatternRun.skippedSuites.length, 1)
        assert.strictEqual(unscopedPatternRun.skippedSuites[0].meta[TEST_STATUS], 'skip')
        assert.strictEqual(unscopedPatternRun.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
        assert.strictEqual(unscopedPatternRun.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
      })
    })

    // Jest can be launched below the repository root while backend suites and coverage use repository-relative paths.
    // This catches regressions where coverage filenames become cwd-relative and stop matching backend meta.coverage.
    it('uses the repository root for jest coverage when launched from a subdirectory', async () => {
      const framework = {
        ...FRAMEWORKS[0],
        command: 'node ./run-jest.js tia-code-coverage',
        cwd: sandboxRoot => path.join(sandboxRoot, 'ci-visibility'),
        getEnv: () => getJestEnv({
          testsToRun: 'tia-code-coverage/test-',
          collectCoverageFrom: 'tia-code-coverage/src/**',
          useJestRun: true,
        }),
      }
      const baseline = await runFramework({ framework })

      assert.strictEqual(baseline.isTiaSkipped, 'false')
      assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)

      const coveredSkippedLines = getLinesBitmapBase64(1, 20)
      const skippedWithCoverage = await runFramework({
        framework,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: coveredSkippedLines,
        },
      })
      const sessionCoverage = skippedWithCoverage.coverages.find(coverage => !coverage.test_suite_id)
      const sessionCoverageFilenames = sessionCoverage.files.map(file => file.filename)

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
      assert.ok(sessionCoverageFilenames.includes(RUN_SOURCE))
      assert.ok(sessionCoverageFilenames.includes(SKIPPED_SOURCE))
    })
  })
}

for (const { version, dependencies } of JEST_VERSION_CONFIGS) {
  describeJestVersion(version, dependencies)
}
