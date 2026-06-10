'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_TESTS_SKIPPED,
  TEST_SKIPPED_BY_ITR,
  TEST_STATUS,
  getLineCoverageBitmap,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'
const CYPRESS_RUN_HARD_TIMEOUT = 70_000
const SPEC_PATTERN = 'cypress/e2e/{other,spec}.cy.js'
const SKIPPED_TEST = {
  type: 'test',
  attributes: {
    name: 'context passes',
    suite: 'cypress/e2e/other.cy.js',
  },
}
const SKIPPED_SOURCE = 'src/utils.tsx'
const SKIPPED_SOURCE_COVERED_LINES = [1, 3, 4, 7]

function gatherCypressPayloads (receiver, childProcess, endpoint, onPayload) {
  return receiver.gatherPayloadsUntilChildExit(
    childProcess,
    ({ url }) => url.endsWith(endpoint),
    onPayload,
    { hardTimeout: CYPRESS_RUN_HARD_TIMEOUT }
  )
}

function getLinesBitmapBase64 (lines) {
  const lineCoverage = {}
  for (const line of lines) {
    lineCoverage[line] = 1
  }
  return getLineCoverageBitmap(lineCoverage, true).toString('base64')
}

function getCoverageEvents (payloads) {
  return payloads
    .flatMap(({ payload }) => payload)
    .flatMap(({ content }) => content.coverages)
}

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  return false
}

const moduleTypes = [
  {
    type: 'commonJS',
    testCommand: function commandWithSuffic (version) {
      const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"' : ''
      return `./node_modules/.bin/cypress run ${commandSuffix}`
    },
  },
  {
    type: 'esm',
    testCommand: `node --loader=${hookFile} ./cypress-esm-config.mjs`,
  },
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

moduleTypes.forEach(({
  type,
  testCommand,
}) => {
  if (typeof testCommand === 'function') {
    testCommand = testCommand(version)
  }

  describe(`TIA code coverage cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.timeout(180_000)

    let cwd, childProcess, webAppBaseUrl, webAppServer

    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)

      const webApp = await startWebAppServer()
      webAppBaseUrl = webApp.baseUrl
      webAppServer = webApp.server
    })

    afterEach(() => {
      if (childProcess?.exitCode === null) {
        childProcess.kill()
      }
      childProcess = undefined
    })

    after(async () => {
      await stopWebAppServer(webAppServer)
    })

    async function runCypress ({
      testsToSkip = [],
      skippableCoverage = {},
      settings = {
        itr_enabled: true,
        code_coverage: true,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      },
      expectTestCoverage = true,
      expectSessionCoverage = true,
      expectCoveragePayloads = true,
      specPattern = SPEC_PATTERN,
      assertEvents,
    } = {}) {
      const receiver = await new FakeCiVisIntake().start()
      receiver.setSettings(settings)
      receiver.setSuitesToSkip(testsToSkip)
      receiver.setSkippableCoverage(skippableCoverage)

      let eventsResult
      let coverageResult
      const coveragePayloads = []
      const coverageRequestListener = (message) => {
        if (message.url.endsWith('/api/v2/citestcov')) {
          coveragePayloads.push(message)
        }
      }
      receiver.on('message', coverageRequestListener)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: specPattern,
          },
        }
      )

      const eventsPromise = gatherCypressPayloads(receiver, childProcess, '/api/v2/citestcycle', payloads => {
        const events = payloads.flatMap(({ payload }) => payload.events)
        const testSession = events.find(event => event.type === 'test_session_end').content
        const skippedTests = events
          .filter(event => event.type === 'test')
          .map(event => event.content)
          .filter(test => test.meta[TEST_SKIPPED_BY_ITR] === 'true')

        eventsResult = {
          codeCoverageLinesPct: testSession.metrics[TEST_CODE_COVERAGE_LINES_PCT],
          isTiaSkipped: testSession.meta[TEST_ITR_TESTS_SKIPPED],
          skippedTests,
          tests: events.filter(event => event.type === 'test').map(event => event.content),
        }
        assertEvents?.(events)
      })

      const coveragePromise = expectCoveragePayloads
        ? gatherCypressPayloads(receiver, childProcess, '/api/v2/citestcov', payloads => {
          const coverages = getCoverageEvents(payloads)
          const testCoverage = coverages.find(coverage => coverage.test_suite_id)
          const sessionCoverage = coverages.find(coverage => !coverage.test_suite_id)
          const coveredFile = coverages
            .flatMap(coverage => coverage.files)
            .find(file => file.bitmap)

          if (expectTestCoverage) {
            assert.ok(testCoverage, 'test code coverage should be reported')
          } else {
            assert.strictEqual(testCoverage, undefined, 'test code coverage should not be reported')
          }
          if (expectSessionCoverage) {
            assert.ok(sessionCoverage, 'session executable-line coverage should be reported')
          } else {
            assert.strictEqual(sessionCoverage, undefined, 'session executable-line coverage should not be reported')
          }
          assert.ok(coveredFile?.bitmap, 'covered files should report line coverage bitmaps')

          coverageResult = coverages
        })
        : Promise.resolve()

      try {
        await Promise.all([
          eventsPromise,
          coveragePromise,
        ])
        if (!expectCoveragePayloads) {
          await new Promise(resolve => setTimeout(resolve, 500))
          assert.strictEqual(coveragePayloads.length, 0, 'code coverage payloads should not be reported')
        }

        return {
          ...eventsResult,
          coverages: coverageResult,
        }
      } finally {
        receiver.off('message', coverageRequestListener)
        await stopCiVisTestEnv({ childProcess, receiver })
        childProcess = undefined
      }
    }

    it('keeps total code coverage stable with skipped coverage', async () => {
      const baseline = await runCypress()

      assert.strictEqual(baseline.isTiaSkipped, 'false')
      assert.ok(baseline.codeCoverageLinesPct > 0)
      assert.ok(baseline.codeCoverageLinesPct < 100)
      assert.ok(baseline.coverages.length > 0, 'baseline should report coverage payloads')

      const skippedWithoutCoverage = await runCypress({
        testsToSkip: [SKIPPED_TEST],
      })

      assert.strictEqual(skippedWithoutCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithoutCoverage.skippedTests.length, 1)
      assert.strictEqual(skippedWithoutCoverage.skippedTests[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithoutCoverage.codeCoverageLinesPct, undefined)

      const skippedWithCoverage = await runCypress({
        testsToSkip: [SKIPPED_TEST],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(SKIPPED_SOURCE_COVERED_LINES),
        },
      })

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedTests.length, 1)
      assert.strictEqual(skippedWithCoverage.skippedTests[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
    })

    it('does not skip tests with missing line coverage when coverage report upload is enabled', async () => {
      const result = await runCypress({
        testsToSkip: [{
          type: 'test',
          attributes: {
            ...SKIPPED_TEST.attributes,
            _is_missing_line_code_coverage: true,
          },
        }],
        specPattern: 'cypress/e2e/other.cy.js',
        assertEvents: (events) => {
          const test = events.find(event =>
            event.content.resource === 'cypress/e2e/other.cy.js.context passes'
          ).content
          assert.strictEqual(test.meta[TEST_STATUS], 'pass')
          assert.notStrictEqual(test.meta[TEST_SKIPPED_BY_ITR], 'true')

          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
        },
      })

      assert.strictEqual(result.isTiaSkipped, 'false')
    })

    it('only uploads test coverage when TIA is enabled but coverage report upload is disabled', async () => {
      const result = await runCypress({
        testsToSkip: [SKIPPED_TEST],
        settings: {
          itr_enabled: true,
          code_coverage: true,
          coverage_report_upload_enabled: false,
          tests_skipping: true,
        },
        expectSessionCoverage: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedTests.length, 1)
      assert.strictEqual(result.skippedTests[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(result.codeCoverageLinesPct, undefined)
    })

    it('does not upload citestcov payloads when TIA code coverage is disabled', async () => {
      const result = await runCypress({
        testsToSkip: [SKIPPED_TEST],
        settings: {
          itr_enabled: true,
          code_coverage: false,
          coverage_report_upload_enabled: false,
          tests_skipping: true,
        },
        expectCoveragePayloads: false,
      })

      assert.strictEqual(result.isTiaSkipped, 'true')
      assert.strictEqual(result.skippedTests.length, 1)
      assert.strictEqual(result.skippedTests[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(result.codeCoverageLinesPct, undefined)
    })

    it('backfills and reports session coverage when coverage report upload is enabled', async () => {
      const settings = {
        itr_enabled: true,
        code_coverage: false,
        coverage_report_upload_enabled: true,
        tests_skipping: true,
      }
      const baseline = await runCypress({
        settings,
        expectTestCoverage: false,
      })

      const skippedWithCoverage = await runCypress({
        testsToSkip: [SKIPPED_TEST],
        skippableCoverage: {
          [SKIPPED_SOURCE]: getLinesBitmapBase64(SKIPPED_SOURCE_COVERED_LINES),
        },
        settings,
        expectTestCoverage: false,
      })
      const sessionCoverage = skippedWithCoverage.coverages.find(coverage => !coverage.test_suite_id)
      const skippedCoverageFile = sessionCoverage.files.find(file => file.filename === SKIPPED_SOURCE)

      assert.strictEqual(skippedWithCoverage.isTiaSkipped, 'true')
      assert.strictEqual(skippedWithCoverage.skippedTests.length, 1)
      assert.strictEqual(skippedWithCoverage.skippedTests[0].meta[TEST_STATUS], 'skip')
      assert.strictEqual(skippedWithCoverage.codeCoverageLinesPct, baseline.codeCoverageLinesPct)
      assert.ok(skippedCoverageFile?.bitmap, 'session coverage should include line coverage bitmaps')
    })
  })
})
