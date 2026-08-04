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
const SUBDIRECTORY_FIXTURE_ROOT = 'tia-code-coverage'
const SKIPPED_SUITE = `${FIXTURE_ROOT}/test-skipped.js`
const SUBDIRECTORY_SKIPPED_SUITE = `${SUBDIRECTORY_FIXTURE_ROOT}/test-skipped.js`
const SKIPPED_SOURCE = `${FIXTURE_ROOT}/src/skipped-dependency.js`
const LINE_PCT_RE = /Lines\s*:\s*(\d+(?:\.\d+)?)%/
const TESTS_TO_RUN = JSON.stringify([
  './tia-code-coverage/test-run.js',
  './tia-code-coverage/test-skipped.js',
])
const MOCHA_COMMAND = './node_modules/nyc/bin/nyc.js --all ' +
  `--include '${FIXTURE_ROOT}/src/**' -r=text-summary node ./ci-visibility/run-mocha.js`
const MINIMUM_SUPPORTED_MOCHA_VERSION = '8.0.0'

const MOCHA_VERSION_CONFIGS = [
  {
    version: 'latest',
    dependencies: ['mocha', 'nyc'],
  },
  {
    version: MINIMUM_SUPPORTED_MOCHA_VERSION,
    dependencies: [`mocha@${MINIMUM_SUPPORTED_MOCHA_VERSION}`, 'nyc'],
  },
]

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

function getSubdirectoryMochaCommand (cwd) {
  const nycBin = path.join(cwd, 'node_modules/nyc/bin/nyc.js')

  return `${nycBin} --all --include '${FIXTURE_ROOT}/src/**' -r=text-summary ` +
    'node -e "process.chdir(\'ci-visibility\'); require(process.cwd() + \'/run-mocha.js\')"'
}

function describeMochaVersion (mochaVersion, dependencies) {
  describe(`TIA code coverage mocha@${mochaVersion}`, function () {
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

    async function runMocha ({
      suitesToSkip = [],
      skippableCoverage = {},
      settings = {
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      },
      expectSuiteCoverage = true,
      expectSessionCoverage = true,
      expectCoveragePayloads = true,
      command = MOCHA_COMMAND,
      runCwd = cwd,
      testsToRun = TESTS_TO_RUN,
    } = {}) {
      const receiver = await new FakeCiVisIntake().start()
      receiver.setSettings(settings)
      receiver.setSuitesToSkip(suitesToSkip)
      receiver.setSkippableCoverage(skippableCoverage)

      let eventsResult
      let coverageResult
      let output = ''
      const coveragePayloads = []
      const coverageRequestListener = (message) => {
        if (message.url.endsWith('/api/v2/citestcov')) {
          coveragePayloads.push(message)
        }
      }
      receiver.on('message', coverageRequestListener)

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

      const coveragePromise = expectCoveragePayloads
        ? receiver.gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
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
        : Promise.resolve()

      childProcess = exec(
        command,
        {
          cwd: runCwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TESTS_TO_RUN: testsToRun,
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
        if (!expectCoveragePayloads) {
          await new Promise(resolve => setTimeout(resolve, 500))
          assert.strictEqual(coveragePayloads.length, 0, `code coverage payloads should not be reported:\n${output}`)
        }

        return {
          ...eventsResult,
          coverages: coverageResult,
          output,
          stdoutCodeCoverageLinesPct: getLinePctFromOutput(output),
        }
      } finally {
        receiver.off('message', coverageRequestListener)
        await receiver.stop()
      }
    }

    // Mocha customers are already running nyc when TIA coverage is available. If a suite is skipped without backend
    // coverage, nyc's local total drops and Datadog withholds lines_pct; with meta.coverage backfill, both totals
    // match.
    it('keeps total code coverage stable with skipped coverage', async () => {
      const baseline = await runMocha()

      assert.strictEqual(baseline.isTiaSkipped, 'false')
      assert.strictEqual(baseline.codeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.ok(baseline.codeCoverageLinesPct > 0, `baseline coverage was ${baseline.codeCoverageLinesPct}`)
      assert.ok(baseline.codeCoverageLinesPct < 100, `baseline coverage was ${baseline.codeCoverageLinesPct}`)
      assert.ok(baseline.coverages.length > 0, 'baseline should report coverage payloads')

      const skippedWithoutCoverage = await runMocha({
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
      })

      assert.strictEqual(skippedWithoutCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithoutCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithoutCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithoutCoverage.codeCoverageLinesPct, undefined)
      assert.ok(
        skippedWithoutCoverage.stdoutCodeCoverageLinesPct < baseline.stdoutCodeCoverageLinesPct,
      `expected ${skippedWithoutCoverage.stdoutCodeCoverageLinesPct} to be lower ` +
      `than ${baseline.stdoutCodeCoverageLinesPct}`
      )

      const skippedWithCoverage = await runMocha({
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
        },
      })

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })

    it('backfills repository-relative skipped coverage when mocha runs from a subdirectory', async () => {
      const runFromSubdirectory = {
        command: getSubdirectoryMochaCommand(cwd),
      }
      const baseline = await runMocha(runFromSubdirectory)

      const skippedWithCoverage = await runMocha({
        ...runFromSubdirectory,
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SUBDIRECTORY_SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
        },
      })
      const sessionCoverage = skippedWithCoverage.coverages.find(coverage => !coverage.test_suite_id)

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
      assert.ok(sessionCoverage.files.some(file => file.filename === SKIPPED_SOURCE))
    })

    // TIA suite-level CITESTCOV collection is independent from Datadog Code Coverage. With report upload disabled we
    // still upload suite coverage for future TIA decisions, but we do not backfill, upload session executable coverage,
    // or tag Datadog lines_pct.
    it('only uploads suite coverage when TIA is enabled but coverage report upload is disabled', async () => {
      const result = await runMocha({
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        settings: {
          itr_enabled: true,
          code_coverage: true,
          coverage_report_upload_enabled: false,
          tests_skipping: true,
        },
        expectSessionCoverage: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedSuites.length, 1)
      assert.strictEqual(result.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(result.codeCoverageLinesPct, undefined)
      assert.ok(result.stdoutCodeCoverageLinesPct > 0)
    })

    // The backend code_coverage flag keeps its original meaning: it controls suite/test CITESTCOV collection for TIA.
    // With both code_coverage and coverage report upload disabled, TIA can still skip, but no coverage payload is sent.
    it('does not upload citestcov payloads when TIA code coverage is disabled', async () => {
      const result = await runMocha({
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        settings: {
          itr_enabled: true,
          code_coverage: false,
          coverage_report_upload_enabled: false,
          tests_skipping: true,
        },
        expectCoveragePayloads: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedSuites.length, 1)
      assert.strictEqual(result.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(result.codeCoverageLinesPct, undefined)
      assert.ok(result.stdoutCodeCoverageLinesPct > 0)
    })

    // coverage_report_upload_enabled is the backfill gate. Even when TIA suite coverage upload is disabled through
    // code_coverage=false, Datadog Code Coverage still gets the session executable-lines payload and backfilled total.
    it('backfills and reports session coverage when coverage report upload is enabled', async () => {
      const settings = {
        itr_enabled: true,
        code_coverage: false,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      }
      const baseline = await runMocha({
        settings,
        expectSuiteCoverage: false,
      })

      const skippedWithCoverage = await runMocha({
        suitesToSkip: [{
          type: 'suite',
          attributes: {
            suite: SKIPPED_SUITE,
          },
        }],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(1, 20),
        },
        settings,
        expectSuiteCoverage: false,
      })

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedSuites.length, 1)
      assert.strictEqual(skippedWithCoverage.skippedSuites[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithCoverage.stdoutCodeCoverageLinesPct, baseline.stdoutCodeCoverageLinesPct)
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })
  })
}

for (const { version, dependencies } of MOCHA_VERSION_CONFIGS) {
  describeMochaVersion(version, dependencies)
}
