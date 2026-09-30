'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { mkdirSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const { join } = require('node:path')

const {
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  MOCHA_IS_PARALLEL,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_ADAPTER,
  TEST_FRAMEWORK_VERSION,
  TEST_IS_RETRY,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MODULE,
  TEST_STATUS,
  TEST_SESSION_EMPTY_REASON,
  TEST_SKIP_REASON,
  TEST_SUITE,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const OLDEST_WEBDRIVERIO_VERSION = '9.0.0'
const requestedVersion = process.env.WEBDRIVERIO_VERSION
const versions = requestedVersion
  ? [requestedVersion === 'oldest' ? OLDEST_WEBDRIVERIO_VERSION : requestedVersion]
  : [OLDEST_WEBDRIVERIO_VERSION, 'latest']

const PNG_SCREENSHOT = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64'
)

const disabledSettings = {
  code_coverage: false,
  tests_skipping: false,
  itr_enabled: false,
  require_git: false,
  early_flake_detection: {
    enabled: false,
  },
  flaky_test_retries_enabled: false,
  di_enabled: false,
  known_tests_enabled: false,
  test_management: {
    enabled: false,
  },
  impacted_tests_enabled: false,
  coverage_report_upload_enabled: false,
}

const advancedRequestPaths = [
  '/api/v2/ci/libraries/tests',
  '/api/v2/ci/tests/skippable',
  '/api/v2/test/libraries/test-management/tests',
]

/**
 * Starts the minimal W3C WebDriver endpoint required by WebdriverIO workers.
 *
 * @returns {Promise<{port: number, server: import('node:http').Server, getSessionCount: () => number}>}
 */
function startWebDriverServer () {
  let sessionCount = 0
  let screenshotCount = 0
  const server = http.createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      const isNewSession = request.method === 'POST' && request.url === '/session'
      let value = null

      if (isNewSession) {
        sessionCount++
        value = {
          sessionId: `webdriverio-${sessionCount}`,
          capabilities: {
            browserName: 'chrome',
            browserVersion: 'test',
            platformName: process.platform,
          },
        }
      } else if (request.method === 'GET' && request.url === '/status') {
        value = { ready: true, message: '' }
      } else if (request.method === 'GET' && /^\/session\/[^/]+\/screenshot$/.test(request.url)) {
        screenshotCount++
        value = PNG_SCREENSHOT.toString('base64')
      }

      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ value }))
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const address = server.address()

      if (!address || typeof address === 'string') {
        reject(new Error('WebDriver server did not bind to a TCP port'))
        return
      }

      resolve({
        port: address.port,
        server,
        getSessionCount: () => sessionCount,
        getScreenshotCount: () => screenshotCount,
      })
    })
  })
}

/**
 * Stops an HTTP server if it is listening.
 *
 * @param {import('node:http').Server|undefined} server
 * @returns {Promise<void>}
 */
function stopServer (server) {
  if (!server?.listening) {
    return Promise.resolve()
  }
  return new Promise(resolve => server.close(resolve))
}

/**
 * Asserts every child event belongs to the coordinator-owned session and module.
 *
 * @param {object} session
 * @param {object} module
 * @param {object[]} suites
 * @param {object[]} tests
 */
function assertEventHierarchy (session, module, suites, tests) {
  const sessionId = session.test_session_id.toString(10)
  const moduleId = module.test_module_id.toString(10)

  assert.strictEqual(module.test_session_id.toString(10), sessionId)

  for (const event of [...suites, ...tests]) {
    assert.strictEqual(event.test_session_id.toString(10), sessionId)
    assert.strictEqual(event.test_module_id.toString(10), moduleId)
  }

  const suiteIds = new Set(suites.map(suite => suite.test_suite_id.toString(10)))
  for (const test of tests) {
    assert.ok(suiteIds.has(test.test_suite_id.toString(10)))
  }
}

/**
 * Asserts each repeated suite execution owns exactly one test event.
 *
 * @param {object[]} suites
 * @param {object[]} tests
 */
function assertOneTestPerSuiteExecution (suites, tests) {
  assert.deepStrictEqual(
    tests.map(test => test.test_suite_id.toString(10)).sort(),
    suites.map(suite => suite.test_suite_id.toString(10)).sort()
  )
}

/**
 * Asserts one failed test's screenshot media and success tags.
 *
 * @param {object} failedTest
 * @param {object[]} media
 */
function assertFailureScreenshotUploaded (failedTest, media) {
  assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
  assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
  assert.strictEqual(media.length, 1)
  assert.strictEqual(media[0].media.traceId, failedTest.trace_id.toString())
  assert.strictEqual(media[0].media.contentType, 'image/png')
  assert.deepStrictEqual(media[0].media.content, PNG_SCREENSHOT)
}

/**
 * Extracts events and verifies the WebdriverIO run kept TIA disabled.
 *
 * @param {object[]} payloads
 * @param {string} requestedVersion
 * @param {string} frameworkAdapter
 * @returns {{session: object, module: object, suites: object[], tests: object[]}}
 */
function getReportingEvents (payloads, requestedVersion, frameworkAdapter) {
  const settingsRequests = payloads.filter(({ url }) =>
    url.endsWith('/api/v2/libraries/tests/services/setting'))
  const advancedRequests = payloads.filter(({ url }) =>
    advancedRequestPaths.some(path => url.endsWith(path)))
  const cyclePayloads = payloads.filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
  const events = cyclePayloads.flatMap(({ payload }) => payload.events)
  const sessions = events.filter(event => event.type === 'test_session_end').map(event => event.content)
  const modules = events.filter(event => event.type === 'test_module_end').map(event => event.content)
  const suites = events.filter(event => event.type === 'test_suite_end').map(event => event.content)
  const tests = events.filter(event => event.type === 'test').map(event => event.content)

  assert.strictEqual(settingsRequests.length, 1)
  assert.strictEqual(advancedRequests.length, 0, JSON.stringify(advancedRequests.map(({ url }) => url)))
  assert.strictEqual(sessions.length, 1, JSON.stringify({
    events: events.map(event => ({
      name: event.content?.name,
      spanType: event.content?.meta?.['span.type'],
      type: event.type,
    })),
    urls: payloads.map(({ url }) => url),
  }))
  assert.strictEqual(modules.length, 1)
  assert.strictEqual(sessions[0].meta[TEST_ITR_SKIPPING_ENABLED], 'false')
  assert.strictEqual(sessions[0].meta[TEST_CODE_COVERAGE_ENABLED], 'false')
  assert.strictEqual(sessions[0].meta[TEST_EARLY_FLAKE_ENABLED], undefined)
  assert.strictEqual(sessions[0].meta[TEST_MANAGEMENT_ENABLED], undefined)

  const metadata = cyclePayloads.flatMap(({ payload }) => payload.metadata || [])
  assert.ok(metadata.length > 0)
  for (const metadataEntry of metadata) {
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], undefined)
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_EARLY_FLAKE_DETECTION], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_AUTO_TEST_RETRIES], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_IMPACTED_TESTS], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE], '1')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX], '5')
    assert.strictEqual(metadataEntry.test[DD_CAPABILITIES_FAILED_TEST_REPLAY], '1')
  }

  for (const event of [sessions[0], modules[0], ...suites, ...tests]) {
    assert.strictEqual(event.meta[TEST_FRAMEWORK], 'webdriverio')
    assert.strictEqual(event.meta[TEST_MODULE], 'webdriverio')
    assert.strictEqual(event.meta[TEST_TYPE], 'browser')
    assert.ok(event.meta[TEST_FRAMEWORK_VERSION])
    if (requestedVersion !== 'latest') {
      assert.strictEqual(event.meta[TEST_FRAMEWORK_VERSION], requestedVersion)
    }
  }
  for (const event of [...suites, ...tests]) {
    assert.strictEqual(event.meta[TEST_FRAMEWORK_ADAPTER], frameworkAdapter)
  }
  assertEventHierarchy(sessions[0], modules[0], suites, tests)

  return {
    media: payloads.filter(({ media }) => media),
    session: sessions[0],
    module: modules[0],
    suites,
    tests,
  }
}

for (const version of versions) {
  describe(`webdriverio@${version}`, function () {
    this.timeout(60_000)

    let childProcess
    let cwd
    let receiver
    let testOutput = ''
    let webDriver

    useSandbox([
      `@wdio/cli@${version}`,
      `@wdio/jasmine-framework@${version}`,
      `@wdio/local-runner@${version}`,
      `@wdio/mocha-framework@${version}`,
    ], true, ['./integration-tests/webdriverio/fixtures/*'])

    before(async function () {
      cwd = sandboxCwd()
      webDriver = await startWebDriverServer()
    })

    after(async function () {
      await stopServer(webDriver?.server)
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
      receiver.setSettings(disabledSettings)
    })

    afterEach(async function () {
      childProcess?.kill()
      testOutput = ''
      await receiver.stop()
    })

    /**
     * Runs one WebdriverIO configuration scenario.
     *
     * @param {string} scenario
     * @param {number} expectedWebDriverSessions
     * @param {(events: ReturnType<typeof getReportingEvents>) => void} assertEvents
     * @param {number} [expectedExitCode]
     * @param {object} [options]
     * @param {object} [options.env]
     * @param {number} [options.expectedScreenshots]
     * @param {string} [options.framework]
     * @returns {Promise<void>}
     */
    async function runScenario (scenario, expectedWebDriverSessions, assertEvents, expectedExitCode = 0, options = {}) {
      const { env, expectedScreenshots, framework = 'mocha' } = options
      const initialWebDriverSessionCount = webDriver.getSessionCount()
      const initialScreenshotCount = webDriver.getScreenshotCount()
      childProcess = exec('./node_modules/.bin/wdio run ./wdio.conf.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_TEST_SESSION_NAME: 'webdriverio-integration-test',
          WEBDRIVERIO_FRAMEWORK: framework,
          WEBDRIVERIO_SCENARIO: scenario,
          WEBDRIVER_PORT: String(webDriver.port),
          ...env,
        },
      })
      const childClosed = once(childProcess, 'close')
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })

      const payloadsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        undefined,
        payloads => assertEvents(getReportingEvents(payloads, version, framework)),
        // WebdriverIO coordinator shutdown waits for the final Test Optimization export.
        { gracePeriod: 0, hardTimeout: 45_000 }
      )

      let exitCode
      try {
        [[exitCode]] = await Promise.all([
          childClosed,
          payloadsPromise,
        ])
      } catch (error) {
        if (childProcess.exitCode !== null || childProcess.signalCode != null) {
          await childClosed.catch(() => {})
        }
        error.message += `\n${testOutput}`
        throw error
      }

      assert.strictEqual(exitCode, expectedExitCode, testOutput)
      assert.doesNotMatch(testOutput, /dd:test-optimization:webdriverio:/)
      assert.doesNotMatch(testOutput, /\bundefined undefined undefined\b/)
      assert.strictEqual(
        webDriver.getSessionCount() - initialWebDriverSessionCount,
        expectedWebDriverSessions
      )
      if (expectedScreenshots !== undefined) {
        assert.strictEqual(webDriver.getScreenshotCount() - initialScreenshotCount, expectedScreenshots)
      }
    }

    it('reports parallel workers as one session', async () => {
      await runScenario('parallel', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.deepStrictEqual(
          suites.map(suite => suite.meta[TEST_SUITE]).sort(),
          ['first.e2e.js', 'second.e2e.js']
        )
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).sort(),
          ['first', 'second']
        )
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      })
    })

    for (const framework of ['mocha', 'jasmine']) {
      it(`reports successful zero-test ${framework} workers as skipped with an explanation`, async () => {
        await runScenario('empty', 0, ({ session, module, suites, tests }) => {
          assert.strictEqual(tests.length, 0)
          assert.strictEqual(suites.length, 1)
          assert.strictEqual(suites[0].meta[TEST_STATUS], 'skip')

          for (const event of [session, module]) {
            assert.strictEqual(event.meta[TEST_STATUS], 'skip')
            assert.strictEqual(event.meta[TEST_SKIP_REASON], 'No tests were detected')
            assert.strictEqual(event.meta[TEST_SESSION_EMPTY_REASON], 'zero_tests')
          }
        }, 0, { framework })
      })
    }

    for (const framework of ['mocha', 'jasmine']) {
      for (const [scenario, sessions, reason, exitCode] of [
        ['allSkipped', 1, 'all_tests_skipped', 0],
        ['emptyShard', 0, 'zero_test_shard', 0],
        ['noWorkers', 0, undefined, 1],
        ['noWorkersSharded', 0, undefined, 0],
      ]) {
        it(`reports zero-execution sessions: ${framework} ${scenario}`, async () => {
          await runScenario(scenario, sessions, ({ session, module, tests }) => {
            assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'skip'))
            for (const event of [session, module]) {
              assert.strictEqual(event.meta[TEST_STATUS], reason ? 'skip' : 'fail')
              assert.strictEqual(event.meta[TEST_SESSION_EMPTY_REASON], reason)
              assert.strictEqual(event.meta[TEST_SKIP_REASON], reason === 'all_tests_skipped'
                ? 'All tests were skipped'
                : reason === 'zero_test_shard'
                  ? 'No tests were assigned to this shard'
                  : reason === 'zero_tests' ? 'No tests were detected' : undefined)
            }
          }, exitCode, { framework })
        })
      }
    }

    it('reports parallel Jasmine workers as one session', async () => {
      await runScenario('parallel', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.deepStrictEqual(
          suites.map(suite => suite.meta[TEST_SUITE]).sort(),
          ['first.e2e.js', 'second.e2e.js']
        )
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).sort(),
          ['first', 'second']
        )
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      }, 0, { framework: 'jasmine' })
    })

    describe('failure videos', () => {
      const videoEnv = { DD_TEST_FAILURE_VIDEOS_ENABLED: 'true', DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'false' }

      before(() => {
        // FFmpeg is only an independent decoder in these assertions, never used by the recorder.
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      })

      for (const framework of ['mocha', 'jasmine']) {
        for (const classic of [true, false]) {
          const browserTest = process.env.WEBDRIVERIO_REAL_BROWSER === 'true' ? it : it.skip
          const protocol = classic ? 'Classic' : 'BiDi'
          browserTest(`records playable ${framework} video in real Chrome (${protocol})`, async () => {
            await runScenario('videosBrowser', 0, ({ media, tests }) => {
              const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
              assert.ok(failed, 'expected a failed browser test; check WebdriverIO output for startup errors')
              assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
              assert.strictEqual(media.length, 1)
              const video = media[0].media
              assert.strictEqual(video.traceId, failed.trace_id.toString())
              assert.strictEqual(video.contentType, 'video/webm')
              // Decode every frame and inspect a pixel in the solid background below the text.
              const pixels = execFileSync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                '-vf', 'crop=1:1:10:500:exact=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
              ], { input: video.content })
              const colors = []
              for (let offset = 0; offset < pixels.length; offset += 3) {
                const [red, green, blue] = pixels.subarray(offset, offset + 3)
                let color
                if (red > 200 && green < 40 && blue < 40) color = 'red'
                if (green > 200 && red < 40 && blue < 40) color = 'green'
                if (blue > 200 && red < 40 && green < 40) color = 'blue'
                if (color && colors.at(-1) !== color) colors.push(color)
              }
              assert.deepStrictEqual(colors, ['red', 'green', 'blue'])
              if (process.env.WEBDRIVERIO_VIDEO_ARTIFACTS) {
                mkdirSync(process.env.WEBDRIVERIO_VIDEO_ARTIFACTS, { recursive: true })
                writeFileSync(join(process.env.WEBDRIVERIO_VIDEO_ARTIFACTS,
                  `${framework}-${classic ? 'classic' : 'bidi'}.webm`), video.content)
              }
            }, 1, {
              framework,
              env: { ...videoEnv, WEBDRIVERIO_CLASSIC: String(classic) },
            })
          })
        }
      }

      for (const framework of ['mocha', 'jasmine']) {
        for (const hook of ['', 'beforeEach', 'afterEach']) {
          it(`uploads ${framework} videos for ${hook || 'test'} failures`, async () => {
            await runScenario('videos', 1, ({ media, tests }) => {
              const failedTests = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
              const videos = media.filter(({ media }) => media.contentType === 'video/webm')
              // Mocha stops this suite after a failed hook; Jasmine still executes the next spec.
              assert.strictEqual(failedTests.length, hook && framework === 'jasmine' ? 2 : 1)
              assert.strictEqual(videos.length, failedTests.length)
              for (const test of tests) {
                assert.strictEqual(test.meta[TEST_FAILURE_VIDEO_UPLOADED],
                  test.meta[TEST_STATUS] === 'fail' ? 'true' : undefined)
                assert.strictEqual(test.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], undefined)
              }
              for (const { media: video, url } of videos) {
                assert.ok(failedTests.some(test => test.trace_id.toString() === video.traceId))
                assert.strictEqual(url.split('?')[0], `/api/v2/ci/test-runs/${video.traceId}/media`)
                assert.deepStrictEqual([...video.content.subarray(0, 4)], [26, 69, 223, 163])
                // Decode the uploaded bytes, rather than accepting only a container signature.
                execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {
                  input: video.content,
                  stdio: ['pipe', 'pipe', 'pipe'],
                })
              }
            }, 1, {
              framework,
              env: { ...videoEnv, WEBDRIVERIO_VIDEO_HOOK: hook },
            })
          })
        }

        it(`keeps ${framework} screenshot and video outcomes independent`, async () => {
          receiver.setMediaResponseStatusCode(400)
          await runScenario('videos', 1, ({ media, tests }) => {
            const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], 'true')
            assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
            assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], 'true')
            assert.deepStrictEqual(media.map(({ media }) => media.contentType).sort(), ['image/png', 'video/webm'])
          }, 1, {
            framework,
            env: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true', DD_TEST_FAILURE_VIDEOS_ENABLED: 'true' },
          })
        })
      }

      for (const framework of ['mocha', 'jasmine']) {
        it(`uploads only the failed native ${framework} retry attempt`, async () => {
          const scenario = framework === 'mocha' ? 'retries' : 'videosJasmineRetry'
          await runScenario(scenario, 1, ({ media, tests }) => {
            assert.strictEqual(tests.length, 2)
            const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            const passedTest = tests.find(test => test.meta[TEST_STATUS] === 'pass')
            assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
            assert.strictEqual(passedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
            assert.strictEqual(media.length, 1)
            assert.strictEqual(media[0].media.traceId, failedTest.trace_id.toString())
          }, 0, { framework, env: videoEnv })
        })
      }

      for (const scenario of ['videosParallel', 'videosMultiremote']) {
        it(`isolates videos across ${scenario}`, async () => {
          await runScenario(scenario, 2, ({ media, tests }) => {
            const failures = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failures.length, scenario === 'videosParallel' ? 2 : 1)
            assert.strictEqual(media.length, 2)
            for (const { media: video } of media) {
              assert.strictEqual(video.contentType, 'video/webm')
              assert.ok(failures.some(test => test.trace_id.toString() === video.traceId))
            }
            assert.ok(failures.every(test => test.meta[TEST_FAILURE_VIDEO_UPLOADED] === 'true'))
          }, 1, { env: videoEnv })
        })
      }

      it('uploads failure videos through the Agent EVP proxy', async () => {
        await runScenario('videos', 1, ({ media, tests }) => {
          const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
          assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
          assert.strictEqual(media.length, 1)
          assert.strictEqual(media[0].media.traceId, failed.trace_id.toString())
          assert.match(media[0].url, /^\/evp_proxy\/v2\/api\/v2\/ci\/test-runs\//)
          assert.strictEqual(media[0].headers['x-datadog-evp-subdomain'], 'api')
          assert.strictEqual(media[0].headers['dd-api-key'], undefined)
        }, 1, {
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
            ...videoEnv,
          },
        })
      })

      for (const enabled of [undefined, 'false']) {
        it(`does not capture or upload when the video flag is ${enabled ?? 'unset'}`, async () => {
          await runScenario('videos', 1, ({ media, tests }) => {
            assert.strictEqual(media.length, 0)
            for (const test of tests) {
              assert.strictEqual(test.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
              assert.strictEqual(test.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], undefined)
            }
          }, 1, { env: { ...videoEnv, DD_TEST_FAILURE_VIDEOS_ENABLED: enabled }, expectedScreenshots: 0 })
        })
      }
    })

    it('reports Jasmine statuses and a failure screenshot by default without global injection', async () => {
      await runScenario('jasmineStatuses', 1, ({ media, session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'jasmine-statuses.e2e.js')
        assert.strictEqual(tests.length, 3)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass', 'skip'])
        assert.strictEqual(
          tests.find(test => test.meta[TEST_STATUS] === 'pass').meta['test.webdriverio.worker'],
          'jasmine'
        )
        const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
        assert.match(failedTest.meta['error.message'], /expected WebdriverIO/)
        assertFailureScreenshotUploaded(failedTest, media)
      }, 1, {
        env: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: undefined },
        expectedScreenshots: 1,
        framework: 'jasmine',
      })
    })

    it('reports failures before Jasmine loads', async () => {
      await runScenario('preFrameworkFailure', 0, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 0)
        assert.strictEqual(tests.length, 0)
      }, 1, { framework: 'jasmine' })
    })

    it('reports Jasmine specs that fail while loading', async () => {
      await runScenario('loadFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'load-fail.e2e.js')
        assert.strictEqual(tests.length, 0)
      }, 1, { framework: 'jasmine' })
    })

    it('reports sequential Jasmine workers as one session', async () => {
      await runScenario('serial', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      }, 0, { framework: 'jasmine' })
    })

    it('reports grouped passing Jasmine behaviors from one worker', async () => {
      await runScenario('jasminePassing', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 5)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['empty.e2e.js', 'skip'],
            ['first.e2e.js', 'pass'],
            ['jasmine-hooks.e2e.js', 'pass'],
            ['runner-env.e2e.js', 'pass'],
            ['second.e2e.js', 'pass'],
          ]
        )
        assert.strictEqual(tests.length, 4)
        assert.ok(tests.every(test => test.meta[TEST_STATUS] === 'pass'))
        const nonEmptySuites = suites.filter(suite => suite.meta[TEST_STATUS] !== 'skip')
        assertOneTestPerSuiteExecution(nonEmptySuites, tests)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 1)
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).filter(Boolean).sort(),
          ['first', 'runner-env-node-options', 'second']
        )
        const hookTest = tests.find(test => test.meta[TEST_SUITE] === 'jasmine-hooks.e2e.js')
        assert.strictEqual(hookTest.meta['test.webdriverio.jasmine.before-each'], 'active')
        assert.strictEqual(hookTest.meta['test.webdriverio.jasmine.after-each'], 'active')
      }, 0, { framework: 'jasmine' })
    })

    it('attributes a Jasmine hook-only failure to its grouped spec', async () => {
      await runScenario('hookFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['hook-fail.e2e.js', 'fail'],
          ]
        )
        assertOneTestPerSuiteExecution(suites, tests)
      }, 1, { framework: 'jasmine' })
    })

    it('reports a Jasmine afterAll failure on its suite', async () => {
      await runScenario('jasmineAfterAllFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'jasmine-after-all-fail.e2e.js')
        assert.match(suites[0].meta['error.message'], /expected WebdriverIO Jasmine afterAll failure/)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta[TEST_STATUS], 'pass')
      }, 0, { framework: 'jasmine' })
    })

    it('reports a Jasmine global afterAll failure on its suite', async () => {
      await runScenario('jasmineGlobalAfterAllFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['jasmine-global-after-all-fail.e2e.js', 'fail'],
          ]
        )
        const failedSuite = suites.find(suite => suite.meta[TEST_STATUS] === 'fail')
        assert.match(failedSuite.meta['error.message'], /expected WebdriverIO Jasmine global afterAll failure/)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]), ['pass', 'pass'])
      }, 0, { framework: 'jasmine' })
    })

    it('starts Jasmine parent spans before tests when settings are delayed', async () => {
      receiver.setSettingsResponseDelay(1_000)

      await runScenario('jasmineDelayedSettings', 1, ({ session, module, suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        const test = tests[0]
        const testEnd = test.start + BigInt(test.duration)

        for (const parent of [session, module, suites[0]]) {
          assert.ok(parent.start <= test.start)
          assert.ok(parent.start + BigInt(parent.duration) >= testEnd)
        }
      }, 0, { framework: 'jasmine' })
    })

    it('reports Jasmine whole-spec retries in one session', async () => {
      await runScenario('specFileRetries', 2, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assertOneTestPerSuiteExecution(suites, tests)

        const suiteStatusById = new Map(suites.map(suite => [
          suite.test_suite_id.toString(10),
          suite.meta[TEST_STATUS],
        ]))
        for (const test of tests) {
          assert.strictEqual(
            test.meta[TEST_STATUS],
            suiteStatusById.get(test.test_suite_id.toString(10))
          )
        }
      }, 0, { framework: 'jasmine' })
    })

    it('reports multiple Jasmine capabilities in one session', async () => {
      await runScenario('multipleCapabilities', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
        assertOneTestPerSuiteExecution(suites, tests)
      }, 0, { framework: 'jasmine' })
    })

    it('reports failures before Mocha loads', async () => {
      await runScenario('preFrameworkFailure', 0, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 0)
        assert.strictEqual(tests.length, 0)
      }, 1)
    })

    it('reports specs that fail while loading', async () => {
      await runScenario('loadFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites[0].meta[TEST_SUITE], 'load-fail.e2e.js')
        assert.strictEqual(tests.length, 0)
      }, 1)
    })

    it('reports sequential workers as one session', async () => {
      await runScenario('serial', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
      })
    })

    it('reports grouped passing Mocha behaviors from one worker', async () => {
      await runScenario('mochaPassing', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 4)
        assert.strictEqual(tests.length, 4)
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 1)
        assertOneTestPerSuiteExecution(suites, tests)
        assert.deepStrictEqual(
          tests.map(test => test.meta['test.webdriverio.worker']).sort(),
          ['delay', 'first', 'runner-env-node-options', 'second']
        )
      })
    })

    it('attributes a hook-only failure to its grouped spec', async () => {
      await runScenario('hookFailure', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['hook-fail.e2e.js', 'fail'],
          ]
        )
      }, 1)
    })

    it('marks a spec filtered by mochaOpts.grep as skipped', async () => {
      await runScenario('grep', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['first.e2e.js', 'pass'],
            ['second.e2e.js', 'skip'],
          ]
        )
      })
    })

    it('reports mochaOpts.bail without leaving grouped suites open', async () => {
      await runScenario('bail', 1, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'fail')
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 1)
        assert.deepStrictEqual(
          suites.map(suite => [suite.meta[TEST_SUITE], suite.meta[TEST_STATUS]]).sort(),
          [
            ['fail.e2e.js', 'fail'],
            ['second.e2e.js', 'skip'],
          ]
        )
      }, 1)
    })

    it('reports native Mocha retries and captures only the failed attempt by default', async () => {
      await runScenario('retries', 1, ({ media, session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(suites[0].meta[TEST_STATUS], 'pass')
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assert.strictEqual(tests.filter(test => test.meta[TEST_IS_RETRY] === 'true').length, 1)
        assertFailureScreenshotUploaded(tests.find(test => test.meta[TEST_STATUS] === 'fail'), media)
      }, 0, {
        env: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: undefined },
        expectedScreenshots: 1,
      })
    })

    for (const framework of ['mocha', 'jasmine']) {
      it(`does not capture or upload ${framework} failure screenshots when explicitly disabled`, async () => {
        await runScenario(framework === 'mocha' ? 'retries' : 'jasmineStatuses', 1, ({ media, tests }) => {
          const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
          assert.ok(failedTest)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
          assert.strictEqual(media.length, 0)
        }, framework === 'mocha' ? 0 : 1, {
          env: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'false' },
          expectedScreenshots: 0,
          framework,
        })
      })
    }

    it('supports the Mocha TDD interface', async () => {
      await runScenario('tdd', 1, ({ suites, tests }) => {
        assert.strictEqual(suites.length, 1)
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.webdriverio.worker'], 'tdd')
      })
    })

    it('reports whole-spec retries in one session', async () => {
      await runScenario('specFileRetries', 2, ({ session, suites, tests }) => {
        assert.strictEqual(session.meta[TEST_STATUS], 'pass')
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], undefined)
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.deepStrictEqual(tests.map(test => test.meta[TEST_STATUS]).sort(), ['fail', 'pass'])
        assertOneTestPerSuiteExecution(suites, tests)

        const suiteStatusById = new Map(suites.map(suite => [
          suite.test_suite_id.toString(10),
          suite.meta[TEST_STATUS],
        ]))
        for (const test of tests) {
          assert.strictEqual(
            test.meta[TEST_STATUS],
            suiteStatusById.get(test.test_suite_id.toString(10))
          )
        }
      })
    })

    it('reports multiple capabilities in one session', async () => {
      await runScenario('multipleCapabilities', 2, ({ session, suites, tests }) => {
        assert.strictEqual(suites.length, 2)
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(session.meta[MOCHA_IS_PARALLEL], 'true')
        assert.strictEqual(new Set(tests.map(test => test.metrics.process_id)).size, 2)
        assertOneTestPerSuiteExecution(suites, tests)
      })
    })
  })
}
