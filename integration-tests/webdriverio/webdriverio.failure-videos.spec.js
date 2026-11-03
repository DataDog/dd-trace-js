'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')
const { execFileSync } = require('node:child_process')
const { once } = require('node:events')
const { mkdirSync, symlinkSync, writeFileSync } = require('node:fs')
const http = require('node:http')
const { join } = require('node:path')

const {
  createParallelIt,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  sandboxCwd,
  useSandbox,
  withReceiver,
} = require('../helpers')
const {
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_ADAPTER,
  TEST_FRAMEWORK_VERSION,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MODULE,
  TEST_STATUS,
  TEST_TYPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const OLDEST_WEBDRIVERIO_VERSION = '9.0.0'
const requestedVersion = process.env.WEBDRIVERIO_VERSION
const versions = requestedVersion
  ? [requestedVersion === 'oldest' ? OLDEST_WEBDRIVERIO_VERSION : requestedVersion]
  : [OLDEST_WEBDRIVERIO_VERSION, 'latest']
const mochaArgs = [...process.argv, ...(process.env.MOCHA_OPTIONS?.split(/\s+/) || [])]
const hasMochaFilter = mochaArgs.some(arg =>
  ['--grep', '--fgrep', '-g', '-f'].includes(arg) || /^(?:--f?grep=|-[gf].+)/.test(arg)
)

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

const scenarioContext = new AsyncLocalStorage()

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
    let body = ''
    request.on('data', chunk => { body += chunk })
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
            unhandledPromptBehavior: JSON.parse(body).capabilities.alwaysMatch.unhandledPromptBehavior ??
              'dismiss and notify',
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
 * Runs WebdriverIO scenarios with isolated intake and WebDriver servers.
 *
 * @param {import('mocha').TestFunction} mochaIt
 * @param {number} concurrency
 * @returns {import('mocha').TestFunction}
 */
function createScenarioIt (mochaIt, concurrency) {
  const register = concurrency === 1
    ? (name, fn) => mochaIt(name, withReceiver(fn))
    : createParallelIt(mochaIt, { concurrency, withReceiver: true })

  const scenarioIt = (name, fn) => register(name, async (receiver, run) => {
    receiver.setSettings(disabledSettings)
    const webDriver = await startWebDriverServer()

    try {
      await scenarioContext.run({ receiver, run, webDriver }, fn)
    } finally {
      try {
        await run.stop()
      } finally {
        await stopServer(webDriver.server)
      }
    }
  })
  scenarioIt.skip = mochaIt.skip.bind(mochaIt)

  return scenarioIt
}

function getScenarioReceiver () {
  return scenarioContext.getStore().receiver
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

    let cwd
    const concurrency = version === OLDEST_WEBDRIVERIO_VERSION && !hasMochaFilter ? 2 : 1

    useSandbox([
      `@wdio/cli@${version}`,
      `@wdio/jasmine-framework@${version}`,
      `@wdio/local-runner@${version}`,
      `@wdio/mocha-framework@${version}`,
      '@sinonjs/fake-timers@15.4.0',
    ], true, ['./integration-tests/webdriverio/fixtures/*'])

    before(function () {
      cwd = sandboxCwd()
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
      const { receiver, run, webDriver } = scenarioContext.getStore()
      const { env, expectedScreenshots, framework = 'mocha' } = options
      let testOutput = ''
      const initialWebDriverSessionCount = webDriver.getSessionCount()
      const initialScreenshotCount = webDriver.getScreenshotCount()
      const childProcess = run('./node_modules/.bin/wdio run ./wdio.conf.js', {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '-r dd-trace/ci/init --import dd-trace/register.js',
          DD_TEST_SESSION_NAME: 'webdriverio-integration-test',
          WEBDRIVERIO_FRAMEWORK: framework,
          WEBDRIVERIO_RETRY_MARKER: join(cwd, `.webdriverio-spec-file-retry-${webDriver.port}`),
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

    describe('failure videos', () => {
      const it = createScenarioIt(global.it, concurrency)
      const serialIt = createScenarioIt(global.it, 1)
      const videoEnv = { DD_TEST_FAILURE_VIDEOS_ENABLED: 'true', DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'false' }

      before(() => {
        // The customer-provided executable records videos and validates their uploaded bytes.
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
      })

      for (const framework of ['mocha', 'jasmine']) {
        for (const [classic, multiremote] of [[true, false], [false, false], [true, true]]) {
          const browserTest = process.env.WEBDRIVERIO_REAL_BROWSER === 'true' ? serialIt : serialIt.skip
          const protocol = multiremote ? 'Classic multiremote with frozen capabilities' : classic ? 'Classic' : 'BiDi'
          browserTest(`records playable ${framework} video in real Chrome (${protocol})`, async () => {
            await runScenario('videosBrowser', 0, ({ media, tests }) => {
              const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
              assert.ok(failed, 'expected a failed browser test; check WebdriverIO output for startup errors')
              assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
              assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'fail').length, 1)
              const dialogs = tests.find(test => test.meta['test.name'].endsWith(
                'preserves dialogs during command-triggered and periodic captures'))
              assert.strictEqual(dialogs?.meta[TEST_STATUS], 'pass')
              assert.strictEqual(media.length, multiremote ? 2 : 1)
              const video = media[0].media
              assert.strictEqual(video.traceId, failed.trace_id.toString())
              assert.strictEqual(video.contentType, 'video/webm')
              const duration = Number(execFileSync('ffprobe', [
                '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', 'pipe:0',
              ], { input: video.content, encoding: 'utf8' }))
              // Allow the final screenshot to settle, but command bursts must not inflate playback.
              assert.ok(duration > 0 && duration < failed.duration / 1e9 + 1,
                `video duration ${duration}s exceeds test duration ${failed.duration / 1e9}s`)
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
                  `${framework}-${protocol.replaceAll(' ', '-')}.webm`), video.content)
              }
            }, 1, {
              framework,
              env: {
                ...videoEnv,
                WEBDRIVERIO_CLASSIC: String(classic),
                WEBDRIVERIO_REAL_MULTIREMOTE: String(multiremote),
                WEBDRIVERIO_FREEZE_LAST_CAPABILITIES: String(multiremote),
              },
            })
          })
        }
      }

      const browserTest = process.env.WEBDRIVERIO_REAL_BROWSER === 'true' ? serialIt : serialIt.skip
      for (const retry of [false, true]) {
        browserTest(`waits for final Chrome captures without teardown hooks (retry=${retry})`, async () => {
          await runScenario('videosBrowserNoHooks', 0, ({ media, tests }) => {
            const failures = tests.filter(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failures.length, retry ? 2 : 1)
            assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
            assert.strictEqual(media.length, failures.length)
            for (const failure of failures) {
              assert.match(failure.meta['error.message'], /failure without teardown hooks/)
              assert.strictEqual(failure.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
              const video = media.find(({ media }) => media.traceId === failure.trace_id.toString()).media
              const pixels = execFileSync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
                '-vf', 'crop=1:1:10:500:exact=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
              ], { input: video.content })
              const [red, green, blue] = pixels.subarray(-3)
              assert.ok(green > 200 && red < 40 && blue < 40, 'final frame must show the failed green page')
            }
          }, 1, {
            env: { ...videoEnv, WEBDRIVERIO_CLASSIC: 'true', WEBDRIVERIO_VIDEO_RETRY: String(retry) },
          })
        })
      }

      for (const multiremote of [false, true]) {
        browserTest(`disables real Chrome video after an unsafe reload (multiremote=${multiremote})`, async () => {
          await runScenario('videosBrowserReload', 0, ({ media, tests }) => {
            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].meta[TEST_STATUS], 'fail')
            assert.match(tests[0].meta['error.message'], /intentional failure after verifying the dialog is preserved/)
            assert.strictEqual(tests[0].meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
            assert.strictEqual(tests[0].meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], undefined)
            assert.strictEqual(media.length, 0)
          }, 1, {
            env: {
              ...videoEnv,
              WEBDRIVERIO_CLASSIC: 'true',
              WEBDRIVERIO_REAL_MULTIREMOTE: String(multiremote),
            },
          })
        })
      }

      for (const hook of ['beforeEach', 'afterEach', 'cascading', 'root', 'retry']) {
        browserTest(`records remaining Chrome teardown after ${hook} failure`, async () => {
          await runScenario('videosBrowserHooks', 0, ({ media, tests }) => {
            assert.strictEqual(tests.length, 1)
            const [test] = tests
            assert.strictEqual(test.meta[TEST_STATUS], 'fail')
            assert.strictEqual(test.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
            const message = hook === 'beforeEach'
              ? /setup failed/
              : hook === 'afterEach' || hook === 'retry' ? /inner teardown failed/ : /final teardown failed/
            assert.match(test.meta['error.message'], message)
            assert.strictEqual(media.length, 1)
            assert.strictEqual(media[0].media.traceId, test.trace_id.toString())
            const pixels = execFileSync('ffmpeg', [
              '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
              '-vf', 'crop=1:1:10:500:exact=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
            ], { input: media[0].media.content })
            const [red, green, blue] = pixels.subarray(-3)
            assert.ok(green > 200 && red < 40 && blue < 40, 'final frame must show the green root teardown page')
          }, 1, {
            env: { ...videoEnv, WEBDRIVERIO_CLASSIC: 'true', WEBDRIVERIO_VIDEO_HOOK: hook },
          })
        })
      }

      for (const hookFails of [false, true]) {
        browserTest(`includes real Chrome teardown in native retry video (hookFails=${hookFails})`, async () => {
          await runScenario('videosBrowserRetry', 0, ({ media, tests }) => {
            assert.strictEqual(tests.length, hookFails ? 1 : 2)
            const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            assert.ok(failed)
            assert.match(failed.meta['error.message'], hookFails ? /teardown failed/ : /retry this failure/)
            assert.strictEqual(media.length, 1)
            assert.strictEqual(media[0].media.traceId, failed.trace_id.toString())
            const pixels = execFileSync('ffmpeg', [
              '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
              '-vf', 'crop=1:1:10:500:exact=1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
            ], { input: media[0].media.content })
            const [red, green, blue] = pixels.subarray(-3)
            assert.ok(green > 200 && red < 40 && blue < 40, 'final frame must show the green teardown page')
          }, hookFails ? 1 : 0, {
            env: {
              ...videoEnv,
              WEBDRIVERIO_CLASSIC: 'true',
              WEBDRIVERIO_VIDEO_HOOK: hookFails ? 'afterEach' : '',
            },
          })
        })
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

        it(`preserves an explicit ${framework} prompt policy and disables videos`, async () => {
          await runScenario('videos', 1, ({ media, tests }) => {
            assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'fail').length, 1)
            assert.strictEqual(media.length, 0)
          }, 1, {
            framework,
            env: { ...videoEnv, WEBDRIVERIO_PROMPT_BEHAVIOR: 'dismiss and notify' },
            expectedScreenshots: 0,
          })
        })

        it(`keeps ${framework} test results and screenshots when FFmpeg is missing`, async () => {
          const nodeOnlyPath = join(cwd, `node-only-${framework}`)
          mkdirSync(nodeOnlyPath)
          symlinkSync(process.execPath, join(nodeOnlyPath, process.platform === 'win32' ? 'node.exe' : 'node'))
          await runScenario('videos', 1, ({ media, tests }) => {
            const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            assert.match(failed.meta['error.message'], /video test failure/)
            assert.strictEqual(tests.filter(test => test.meta[TEST_STATUS] === 'pass').length, 1)
            assertFailureScreenshotUploaded(failed, media)
            assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
            assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], undefined)
          }, 1, {
            framework,
            env: {
              ...videoEnv,
              DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true',
              WEBDRIVERIO_EXPECT_PROMPT_BEHAVIOR: 'dismiss and notify',
              WEBDRIVERIO_CLASSIC: 'true',
              // Keep Node available even when it shares an installation directory with FFmpeg.
              PATH: nodeOnlyPath,
            },
          })
        })

        it(`keeps ${framework} screenshot and video outcomes independent`, async () => {
          getScenarioReceiver().setMediaResponseStatusCode(400)
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

        it(`uploads ${framework} screenshots and videos when setup installs a zero-epoch fake Date`, async () => {
          await runScenario('videos', 1, ({ media, tests }) => {
            const failed = tests.find(test => test.meta[TEST_STATUS] === 'fail')
            assert.strictEqual(failed.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
            assert.strictEqual(failed.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
            assert.deepStrictEqual(media.map(({ media }) => media.contentType).sort(), ['image/png', 'video/webm'])
            for (const { media: file } of media) assert.ok(Number(file.capturedAt) > 0)
          }, 1, {
            framework,
            env: { ...videoEnv, DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true', WEBDRIVERIO_FAKE_DATE: 'true' },
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
            ...getCiVisEvpProxyConfig(getScenarioReceiver().port),
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
  })
}
