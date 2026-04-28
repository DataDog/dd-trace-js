'use strict'

const assert = require('node:assert')
const { once } = require('node:events')
const { pathToFileURL } = require('node:url')
const { exec, execSync } = require('child_process')
const path = require('path')
const satisfies = require('semifies')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_CODE_COVERAGE_ENABLED,
  TEST_ITR_FORCED_RUN,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_TESTS_SKIPPED,
  TEST_ITR_UNSKIPPABLE,
  TEST_SKIPPED_BY_ITR,
  TEST_STATUS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_MAJOR } = require('../../version')

const { PLAYWRIGHT_VERSION } = process.env

const latest = 'latest'
const oldest = DD_MAJOR >= 6 ? '1.38.0' : '1.18.0'
const versions = [oldest, latest]

function getCoverageFilenames (payloads) {
  return payloads
    .flatMap(({ payload }) => payload)
    .flatMap(({ content: { coverages } }) => coverages)
    .flatMap(({ files }) => files)
    .map(({ filename }) => filename)
}

function assertCoverageIncludes (coveredFiles, expectedFiles) {
  for (const filename of expectedFiles) {
    assert.ok(coveredFiles.includes(filename), `Expected coverage files ${coveredFiles} to include ${filename}`)
  }
}

function findSuiteByFilename (suites, filename) {
  return suites.find(event => event.content.resource.endsWith(filename))
}

function getBundledSourceMapSources (cwd, sourceRoot = 'ci-visibility/web-app-src') {
  return ['greeting.ts', 'math.ts'].map(filename =>
    pathToFileURL(path.join(cwd, sourceRoot, filename)).toString()
  )
}

function listen (server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, (err) => {
      server.off('error', reject)
      if (err) return reject(err)
      resolve(server.address().port)
    })
  })
}

function setTiaSettings (receiver, { codeCoverage = true, testsSkipping = true } = {}) {
  receiver.setSettings({
    itr_enabled: true,
    code_coverage: codeCoverage,
    tests_skipping: testsSkipping,
    flaky_test_retries_enabled: false,
    early_flake_detection: { enabled: false },
  })
}

versions.forEach((version) => {
  if (PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) return
  if (PLAYWRIGHT_VERSION === 'latest' && version !== latest) return

  // TODO: Remove this once we drop suppport for v5
  const contextNewVersions = (...args) => {
    if (satisfies(version, '>=1.38.0') || version === 'latest') {
      context(...args)
    }
  }

  describe(`playwright@${version}`, function () {
    let cwd, receiver, childProcess

    this.retries(2)
    this.timeout(80000)

    // TODO: Update tests files accordingly and test with different TS versions
    useSandbox([`@playwright/test@${version}`, '@types/node', 'typescript@5'], true)

    before(function () {
      // Increase timeout for this hook specifically to account for slow chromium installation in CI
      this.timeout(120000)

      cwd = sandboxCwd()
      const { NODE_OPTIONS, ...restOfEnv } = process.env
      // Install chromium (configured in integration-tests/playwright.config.js)
      // *Be advised*: this means that we'll only be using chromium for this test suite
      // This will use cached browsers if available, otherwise download
      execSync('npx playwright install chromium', { cwd, env: restOfEnv, stdio: 'inherit' })
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      if (childProcess) {
        childProcess.kill()
        childProcess = undefined
      }
      await receiver.stop()
    })

    contextNewVersions('test impact analysis', () => {
      it('skips test files reported by the skippable API and still reports code coverage', async () => {
        setTiaSettings(receiver)
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/playwright-tests-zero-config-tia/skipped-test.js',
          },
        }])

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const coveragePromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = getCoverageFilenames(payloads)

            assertCoverageIncludes(coveredFiles, [
              'ci-visibility/web-app-src/greeting.ts',
              'ci-visibility/web-app-src/math.ts',
              'ci-visibility/playwright-tests-zero-config-tia/covered-test.js',
            ])
            assert.ok(!coveredFiles.includes('ci-visibility/playwright-tests-zero-config-tia/skipped-test.js'))
            assert.ok(!coveredFiles.some(filename => filename.endsWith('/bundle.js') || filename === 'bundle.js'))
            assert.ok(coveredFiles.every(filename => !path.isAbsolute(filename)))
          }, 60000)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const skippedSuite = events.find(event =>
              event.type === 'test_suite_end' &&
              event.content.resource === 'test_suite.ci-visibility/playwright-tests-zero-config-tia/skipped-test.js'
            )
            assert.ok(skippedSuite, 'skipped-test.js should be reported as a skipped suite')
            assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.content.meta[TEST_SKIPPED_BY_ITR], 'true')

            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-zero-config-tia',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
            coveragePromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('does not skip suites marked as unskippable and still reports code coverage', async () => {
        setTiaSettings(receiver)
        receiver.setSuitesToSkip([
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/playwright-tests-unskippable/skip-test.js',
            },
          },
          {
            type: 'suite',
            attributes: {
              suite: 'ci-visibility/playwright-tests-unskippable/unskippable-test.js',
            },
          },
        ])

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const coveragePromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = getCoverageFilenames(payloads)

            assertCoverageIncludes(coveredFiles, [
              'ci-visibility/web-app-src/greeting.ts',
              'ci-visibility/web-app-src/math.ts',
              'ci-visibility/playwright-tests-unskippable/pass-test.js',
              'ci-visibility/playwright-tests-unskippable/unskippable-test.js',
            ])
            assert.ok(!coveredFiles.includes('ci-visibility/playwright-tests-unskippable/skip-test.js'))
            assert.ok(coveredFiles.every(filename => !path.isAbsolute(filename)))
          }, 60000)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const suites = events.filter(event => event.type === 'test_suite_end')

            assert.strictEqual(suites.length, 3)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_module_end').content

            assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
            assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
            assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)

            const passedSuite = findSuiteByFilename(suites, 'pass-test.js')
            const skippedSuite = findSuiteByFilename(suites, 'skip-test.js')
            const forcedToRunSuite = findSuiteByFilename(suites, 'unskippable-test.js')

            assert.ok(passedSuite, 'pass-test.js should be reported')
            assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
            assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
            assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

            assert.ok(skippedSuite, 'skip-test.js should be reported as skipped')
            assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.content.meta[TEST_SKIPPED_BY_ITR], 'true')
            assert.ok(!(TEST_ITR_UNSKIPPABLE in skippedSuite.content.meta))
            assert.ok(!(TEST_ITR_FORCED_RUN in skippedSuite.content.meta))

            assert.ok(forcedToRunSuite, 'unskippable-test.js should be reported')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_FORCED_RUN], 'true')
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-unskippable',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
            coveragePromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('keeps tests_skipped false if only unskippable suites are returned by TIA', async () => {
        setTiaSettings(receiver)
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/playwright-tests-unskippable/unskippable-test.js',
          },
        }])

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const suites = events.filter(event => event.type === 'test_suite_end')
            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_module_end').content
            const forcedToRunSuite = findSuiteByFilename(suites, 'unskippable-test.js')

            assert.strictEqual(suites.length, 3)
            assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
            assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 0)

            assert.ok(forcedToRunSuite, 'unskippable-test.js should be reported')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.strictEqual(forcedToRunSuite.content.meta[TEST_ITR_FORCED_RUN], 'true')
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-unskippable',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('only sets forced to run if the unskippable suite was going to be skipped by TIA', async () => {
        setTiaSettings(receiver)
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/playwright-tests-unskippable/skip-test.js',
          },
        }])

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const suites = events.filter(event => event.type === 'test_suite_end')

            assert.strictEqual(suites.length, 3)

            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_module_end').content

            assert.ok(!(TEST_ITR_FORCED_RUN in testSession.meta))
            assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.ok(!(TEST_ITR_FORCED_RUN in testModule.meta))
            assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')

            const passedSuite = findSuiteByFilename(suites, 'pass-test.js')
            const skippedSuite = findSuiteByFilename(suites, 'skip-test.js')
            const unskippableSuite = findSuiteByFilename(suites, 'unskippable-test.js')

            assert.ok(passedSuite, 'pass-test.js should be reported')
            assert.strictEqual(passedSuite.content.meta[TEST_STATUS], 'pass')
            assert.ok(!(TEST_ITR_UNSKIPPABLE in passedSuite.content.meta))
            assert.ok(!(TEST_ITR_FORCED_RUN in passedSuite.content.meta))

            assert.ok(skippedSuite, 'skip-test.js should be reported as skipped')
            assert.strictEqual(skippedSuite.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.content.meta[TEST_SKIPPED_BY_ITR], 'true')

            assert.ok(unskippableSuite, 'unskippable-test.js should be reported')
            assert.strictEqual(unskippableSuite.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(unskippableSuite.content.meta[TEST_ITR_UNSKIPPABLE], 'true')
            assert.ok(!(TEST_ITR_FORCED_RUN in unskippableSuite.content.meta))
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-unskippable',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('sets _dd.ci.itr.tests_skipped to false if TIA receives a suite that is not skipped', async () => {
        setTiaSettings(receiver)
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/playwright-tests-zero-config-tia/not-existing-test.js',
          },
        }])

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const suites = events.filter(event => event.type === 'test_suite_end')
            const skippedSuites = suites.filter(suite => suite.content.meta[TEST_STATUS] === 'skip')
            const testSession = events.find(event => event.type === 'test_session_end').content
            const testModule = events.find(event => event.type === 'test_module_end').content

            assert.strictEqual(skippedSuites.length, 0)
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
            assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
            assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
            assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 0)
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-zero-config-tia',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('reports zero-config browser code coverage for bundled TypeScript web app source files', async () => {
        setTiaSettings(receiver, { testsSkipping: false })

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const coveragePromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = getCoverageFilenames(payloads)

            assertCoverageIncludes(coveredFiles, [
              'ci-visibility/web-app-src/greeting.ts',
              'ci-visibility/web-app-src/math.ts',
              'ci-visibility/playwright-tests-test-capabilities/passing-test.js',
            ])
            assert.ok(!coveredFiles.some(filename => filename.endsWith('/bundle.js') || filename === 'bundle.js'))
            assert.ok(coveredFiles.every(filename => !path.isAbsolute(filename)))
          }, 60000)

        childProcess = exec(
          './node_modules/.bin/playwright test -c playwright.config.js',
          {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
              TEST_DIR: './ci-visibility/playwright-tests-test-capabilities',
            },
          }
        )

        try {
          await Promise.all([
            once(childProcess, 'exit'),
            coveragePromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('does not report zero-config browser code coverage if disabled by the API', async () => {
        setTiaSettings(receiver, { codeCoverage: false, testsSkipping: false })

        const coverageRequests = []
        const onMessage = message => {
          if (message.url?.endsWith('/api/v2/citestcov')) {
            coverageRequests.push(message)
          }
        }
        receiver.on('message', onMessage)

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const eventsPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSession = events.find(event => event.type === 'test_session_end').content
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-test-capabilities',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            eventsPromise,
          ])
          assert.deepStrictEqual(coverageRequests, [])
        } finally {
          receiver.off('message', onMessage)
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('reports zero-config browser code coverage with multiple workers', async () => {
        setTiaSettings(receiver, { testsSkipping: false })

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const coveragePromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = getCoverageFilenames(payloads)

            assertCoverageIncludes(coveredFiles, [
              'ci-visibility/web-app-src/greeting.ts',
              'ci-visibility/web-app-src/math.ts',
              'ci-visibility/playwright-tests-zero-config-tia/covered-test.js',
              'ci-visibility/playwright-tests-zero-config-tia/skipped-test.js',
            ])
            assert.ok(coveredFiles.every(filename => !path.isAbsolute(filename)))
          }, 60000)

        try {
          childProcess = exec(
            './node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                FULLY_PARALLEL: 'true',
                PLAYWRIGHT_WORKERS: '2',
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
                TEST_DIR: './ci-visibility/playwright-tests-zero-config-tia',
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            coveragePromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })

      it('reports zero-config browser code coverage relative to the repository root', async () => {
        setTiaSettings(receiver, { testsSkipping: false })

        const zeroConfigWebAppServer = createWebAppServer({
          skipIstanbulFixture: true,
          bundledSourceMapSources: getBundledSourceMapSources(cwd, 'ci-visibility/subproject/src'),
        })
        const zeroConfigWebAppPort = await listen(zeroConfigWebAppServer)

        const coveragePromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcov'), (payloads) => {
            const coveredFiles = getCoverageFilenames(payloads)

            assertCoverageIncludes(coveredFiles, [
              'ci-visibility/subproject/src/greeting.ts',
              'ci-visibility/subproject/src/math.ts',
              'ci-visibility/subproject/playwright-tests/landing-page-test.js',
            ])
            assert.ok(coveredFiles.every(filename => !path.isAbsolute(filename)))
          }, 60000)

        try {
          childProcess = exec(
            '../../node_modules/.bin/playwright test -c playwright.config.js',
            {
              cwd: `${cwd}/ci-visibility/subproject`,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                PW_BASE_URL: `http://localhost:${zeroConfigWebAppPort}`,
              },
            }
          )

          await Promise.all([
            once(childProcess, 'exit'),
            coveragePromise,
          ])
        } finally {
          await new Promise(resolve => zeroConfigWebAppServer.close(resolve))
        }
      })
    })
  })
})
