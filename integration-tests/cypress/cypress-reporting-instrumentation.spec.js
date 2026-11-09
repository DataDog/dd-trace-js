'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const { createServer } = require('node:http')
const path = require('node:path')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_FRAMEWORK,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_SCOPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
} = require('../../packages/dd-trace/src/ci-visibility/test-video')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const { getCypressDependencies } = require('./dependencies')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const cypressVersionsSupportingNode18 = DD_MAJOR === 5
  ? ['10.2.0', '12.0.0', '14.5.4']
  : ['12.0.0', '14.5.4']

function getGeneratedSupportFiles (directory) {
  return fs.readdirSync(directory)
    .filter(filename => filename.startsWith('dd-cypress-support-'))
    .sort()
}

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return cypressVersionsSupportingNode18.includes(version)
      }
      return cypressVersionsSupportingNode18.includes(version) || version === 'latest'
    }
  }
  if (DD_MAJOR >= 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return cypressVersionsSupportingNode18.includes(version)
      }
      return cypressVersionsSupportingNode18.includes(version) || version === 'latest'
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
    testCommand: 'node ./cypress-esm-config.mjs',
  },
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

moduleTypes.forEach(({
  type,
  testCommand,
}) => {
  if (typeof testCommand === 'function') {
    testCommand = testCommand(version)
  }

  describe(`cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.timeout(80_000)
    let cwd, receiver, childProcess, webAppBaseUrl, webAppServer

    const sandboxDependencies = getCypressDependencies(version)
    if (type === 'commonJS' && version === 'latest') {
      // These dependencies are only needed by the component/Vite regression test below.
      sandboxDependencies.push(
        '@vitejs/plugin-react@6.1.1',
        'react@18.3.1',
        'react-dom@18.3.1',
        'vite@8.2.2'
      )
    }
    useSandbox(sandboxDependencies, true)

    before(async function () {
      this.timeout(180_000)
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)

      const webApp = await startWebAppServer()
      webAppBaseUrl = webApp.baseUrl
      webAppServer = webApp.server
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    after(async () => {
      await stopWebAppServer(webAppServer)
    })

    // These tests require Cypress >=10 features (defineConfig, setupNodeEvents)
    const over10It = (version !== '6.7.0') ? it : it.skip

    // These CLI fixtures exercise lifecycle behavior, not module loading. Running them in the ESM cell
    // would repeat the same .js configs; dedicated tests below cover .mjs config loading and hook chaining.
    if (type === 'commonJS') {
      describe('late manual finalization', () => {
        /**
         * Run the fixture and check the event hierarchy shared by all recovery scenarios.
         * @param {{ afterSpec?: 'missing'|'partial'|'forwarded', screenshots?: boolean, video?: boolean }} options
         */
        async function runLateManual ({ afterSpec = 'missing', screenshots = false, video = false }) {
          let output = ''
          const command = './node_modules/.bin/cypress run --config-file ci-visibility/cypress-late-manual/config.js'
          childProcess = exec(command, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '',
              DD_CYPRESS_AFTER_SPEC_MODE: afterSpec,
              DD_TEST_FAILURE_SCREENSHOTS_ENABLED: String(screenshots),
              DD_TEST_FAILURE_VIDEOS_ENABLED: String(video),
            },
          })
          childProcess.stdout?.on('data', chunk => { output += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { output += chunk.toString() })
          let messages
          const [[exitCode]] = await Promise.all([
            once(childProcess, 'close'),
            receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url, media }) => url.endsWith('/api/v2/citestcycle') || !!media,
              payloads => { messages = payloads }
            ),
          ])
          const events = messages.flatMap(({ payload }) => payload?.events ?? [])
          const uploads = messages.filter(({ media }) => media).map(({ media }) => media)
          assert.strictEqual(exitCode, 1, output)
          assert.match(output, /synthetic late hook failure/)
          const tests = events.filter(event => event.type === 'test').map(({ content }) => content)
          const suites = events.filter(event => event.type === 'test_suite_end').map(({ content }) => content)
          assert.deepStrictEqual(tests.map(({ meta }) => ({
            name: meta['test.name'],
            status: meta[TEST_STATUS],
          })).sort((a, b) => a.name.localeCompare(b.name)), [
            { name: 'first suite is skipped', status: 'skip' },
            { name: 'first suite passes', status: 'pass' },
            { name: 'second suite fails in a late hook', status: 'fail' },
          ], output)
          assert.strictEqual(suites.length, 2)
          assert.strictEqual(new Set(suites.map(suite => String(suite.test_suite_id))).size, 2)
          for (const test of tests) {
            const suite = suites.find(suite => suite.meta['test.suite'] === test.meta['test.suite'])
            assert.ok(suite)
            assert.strictEqual(String(test.test_suite_id), String(suite.test_suite_id))
            // Recovery at after:run must keep tests inside their original suite, not move them to run end.
            // Compare at Cypress run-result precision (milliseconds).
            const testStart = Math.round(Number(test.start) / 1e6)
            const testEnd = Math.round((Number(test.start) + Number(test.duration)) / 1e6)
            const suiteStart = Math.round(Number(suite.start) / 1e6)
            const suiteEnd = Math.round((Number(suite.start) + Number(suite.duration)) / 1e6)
            assert.ok(testStart >= suiteStart && testEnd <= suiteEnd,
              `${test.meta['test.name']}: ${testStart}-${testEnd} must be within suite ${suiteStart}-${suiteEnd}`)
            if (test.meta[TEST_STATUS] === 'skip' && afterSpec === 'missing') {
              assert.strictEqual(Number(test.duration), 0)
              assert.strictEqual(testStart, suiteEnd)
            }
          }
          const firstSuite = suites.find(suite => suite.meta['test.suite'].endsWith('first.cy.js'))
          const secondSuite = suites.find(suite => suite.meta['test.suite'].endsWith('second.cy.js'))
          assert.strictEqual(firstSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(secondSuite.meta[TEST_STATUS], 'fail')
          assert.ok(Number(firstSuite.start) + Number(firstSuite.duration) < Number(secondSuite.start),
            `recovered suite duration must not include later specs\n${output}`)
          const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
          assert.match(failedTest.meta[ERROR_MESSAGE], /synthetic late hook failure/)
          for (const type of ['test_session_end', 'test_module_end']) {
            assert.deepStrictEqual(events.filter(event => event.type === type)
              .map(({ content }) => content.meta[TEST_STATUS]), ['fail'], type)
          }
          return { failedTest, failedSuite: secondSuite, uploads }
        }

        over10It('recovers both specs with screenshots but no video when after:spec is missing', async () => {
          receiver.setMediaResponseDelay(100)
          const { failedTest, failedSuite, uploads } = await runLateManual({ screenshots: true })

          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
          assert.strictEqual(failedSuite.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
          assert.deepStrictEqual(uploads.map(media => media.contentType), ['image/png'])
          assert.strictEqual(uploads[0].traceId, String(failedTest.trace_id))
        })

        over10It('recovers the second spec with media when after:spec handles only the first', async () => {
          receiver.setMediaResponseDelay(100)
          const { failedTest, failedSuite, uploads } = await runLateManual({
            afterSpec: 'partial', screenshots: true, video: true,
          })

          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
          assert.strictEqual(failedSuite.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
          assert.deepStrictEqual(uploads.map(media => media.contentType).sort(), ['image/png', 'video/mp4'])
          const screenshot = uploads.find(media => media.contentType === 'image/png')
          const video = uploads.find(media => media.contentType === 'video/mp4')
          assert.strictEqual(screenshot.traceId, String(failedTest.trace_id))
          assert.strictEqual(video.testSuiteId, String(failedSuite.test_suite_id))
        })

        over10It('does not duplicate specs already finalized by after:spec', async () => {
          await runLateManual({ afterSpec: 'forwarded' })
        })
      })

      for (const { manual, reject } of [
        { manual: false, reject: false },
        { manual: true, reject: false },
        { manual: false, reject: true },
        { manual: true, reject: true },
      ]) {
        over10It(`preserves before:run handlers (manual=${manual}, reject=${reject})`, async () => {
          let output = ''
          const events = []
          receiver.on('message', ({ url, payload }) => {
            if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
          })
          childProcess = exec('./node_modules/.bin/cypress run --config-file cypress-before-run.config.js', {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              CYPRESS_MANUAL_PLUGIN: manual ? '1' : '',
              CYPRESS_REJECT_BEFORE_RUN: reject ? '1' : '',
            },
          })
          childProcess.stdout?.on('data', chunk => { output += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { output += chunk.toString() })
          const [exitCode] = await once(childProcess, 'close')
          const tests = events.filter(event => event.type === 'test')
          if (reject) {
            assert.strictEqual(events.length, 0)
            assert.notStrictEqual(exitCode, 0)
            assert.match(output, /custom before:run failed/)
          } else {
            assert.strictEqual(exitCode, 0, output)
            assert.deepStrictEqual(tests.map(({ content }) => content.meta[TEST_STATUS]), ['pass'], output)
          }
        })
      }
    }

    // Regression guard: when OTEL_TRACES_EXPORTER=otlp is set in the
    // environment (e.g. by an unrelated OpenTelemetry-instrumented shell),
    // the tracer must still ship Test Optimization spans to
    // /api/v2/citestcycle instead of silently replacing the Test
    // Optimization exporter with OtlpHttpTraceExporter and dropping all
    // test_session / test_module / test_suite / test spans.
    over10It('keeps Test Optimization exporter when OTEL_TRACES_EXPORTER=otlp is set', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            // Simulates a user shell that already exports OTEL_* vars for
            // a separate OTEL collector. The Test Optimization exporter
            // must win inside isCiVisibility mode.
            OTEL_TRACES_EXPORTER: 'otlp',
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
      // TODO: remove this once we have figured out flakiness
      childProcess.stdout?.pipe(process.stdout)
      childProcess.stderr?.pipe(process.stderr)

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const sessionEvents = events.filter(event => event.type === 'test_session_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(sessionEvents.length, 1, 'one test_session span must reach citestcycle')

            const passedTest = testEvents.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over10It('does not modify the user support file and cleans up the injected wrapper', async () => {
      const supportFilePath = path.join(cwd, 'cypress/support/e2e.js')
      const originalSupportContent = fs.readFileSync(supportFilePath, 'utf8')
      const supportContentWithoutDdTrace = originalSupportContent
        .split('\n')
        .filter(line => !line.includes("require('dd-trace/ci/cypress/support')"))
        .join('\n')

      const getSupportWrappers = () => fs.readdirSync(path.dirname(supportFilePath))
        .filter(filename => filename.startsWith('dd-cypress-support-'))
        .sort()

      fs.writeFileSync(supportFilePath, supportContentWithoutDdTrace)

      const envVars = getCiVisAgentlessConfig(receiver.port)
      const wrapperFilesBefore = getSupportWrappers()

      try {
        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
              const passedTest = events.find(event =>
                event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
              )

              assertObjectContains(passedTest?.content, {
                meta: {
                  [TEST_STATUS]: 'pass',
                  [TEST_FRAMEWORK]: 'cypress',
                },
              })
            },
            { hardTimeout: 60000 }
          )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
        assert.strictEqual(fs.readFileSync(supportFilePath, 'utf8'), supportContentWithoutDdTrace)
        assert.doesNotMatch(fs.readFileSync(supportFilePath, 'utf8'), /dd-trace\/ci\/cypress\/support/)
        assert.deepStrictEqual(getSupportWrappers(), wrapperFilesBefore)
      } finally {
        fs.writeFileSync(supportFilePath, originalSupportContent)
      }
    })

    over10It('retries when dd:beforeEach returns no result once', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      let testOutput = ''

      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: webAppBaseUrl,
          CYPRESS_DD_BEFORE_EACH_NO_RESULT_ONCE: '1',
          SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
        },
      })
      childProcess.stdout?.on('data', (data) => { testOutput += data })
      childProcess.stderr?.on('data', (data) => { testOutput += data })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )

            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          },
          { hardTimeout: 60000 }
        )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.match(testOutput, /\[datadog:test\] dd:beforeEach call 1/)
      assert.match(testOutput, /\[datadog:test\] dd:beforeEach call 2/)
    })

    over10It('preserves config returned from setupNodeEvents', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      const returnConfigFile = type === 'esm'
        ? 'cypress-return-config.config.mjs'
        : 'cypress-return-config.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${returnConfigFile}`,
        {
          cwd,
          env: envVars,
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource ===
              'cypress/e2e/returned-config.cy.js.returned config uses env from setupNodeEvents return value'
            )

            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over10It('custom after:spec and after:run handlers are chained with dd-trace instrumentation', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      let testOutput = ''
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })
      childProcess.stdout?.on('data', (d) => { testOutput += d })
      childProcess.stderr?.on('data', (d) => { testOutput += d })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        receiverPromise,
      ])

      // Verify both dd-trace spans AND the custom handlers ran (including their async resolutions)
      assert.match(testOutput, /\[custom:after:spec\]/)
      assert.match(testOutput, /\[custom:after:spec:resolved\]/)
      assert.match(testOutput, /\[custom:after:run\]/)
      assert.match(testOutput, /\[custom:after:run:resolved\]/)
    })

    for (const { testName, rejectionVariable, expectedError } of [
      {
        testName: 'reports the session when a custom after:run handler rejects',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_RUN',
        expectedError: /custom after:run failed/,
      },
      {
        testName: 'reports a string rejection from a custom after:run handler',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_RUN_WITH_STRING',
        expectedError: /custom after:run string rejection/,
      },
    ]) {
      over10It(testName, async () => {
        const envVars = getCiVisAgentlessConfig(receiver.port)
        const customHooksConfigFile = type === 'esm'
          ? 'cypress-custom-after-hooks.config.mjs'
          : 'cypress-custom-after-hooks.config.js'

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              [rejectionVariable]: '1',
              SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
            },
          }
        )

        const receiverPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            for (const eventType of ['test_session_end', 'test_module_end']) {
              const event = events.find(event => event.type === eventType)
              assert.ok(event, `expected ${eventType} event`)
              assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(event.content.error, 1)
              assert.match(event.content.meta[ERROR_MESSAGE], expectedError)
            }
            const testSuite = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuite, 'expected test_suite_end event')
            assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSuite.content.error, 0)
          },
          { hardTimeout: 60000 }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.notStrictEqual(exitCode, 0)
      })
    }

    over10It('keeps completed suites passing when a later after:spec handler rejects', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_REJECT_SECOND_AFTER_SPEC: '1',
            SPEC_PATTERN: 'cypress/e2e/{basic-pass,other.cy}.js',
          },
        }
      )
      let testOutput = ''
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suiteEvents = events.filter(event => event.type === 'test_suite_end')
          const completedSuite = suiteEvents.find(event => event.content.meta[TEST_STATUS] === 'pass')
          const failedSuite = suiteEvents.find(event => event.content.meta[TEST_STATUS] === 'fail')

          assert.strictEqual(suiteEvents.length, 2)
          assert.deepStrictEqual(suiteEvents.map(event => event.content.resource).sort(), [
            'test_suite.cypress/e2e/basic-pass.js',
            'test_suite.cypress/e2e/other.cy.js',
          ])
          assert.ok(completedSuite, `expected the completed suite event\n${testOutput}`)
          assert.strictEqual(completedSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(completedSuite.content.error, 0)
          assert.ok(failedSuite, 'expected the failed suite event')
          assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(failedSuite.content.error, 1)
          assert.match(failedSuite.content.meta[ERROR_MESSAGE], /custom after:spec failed/)

          for (const eventType of ['test_session_end', 'test_module_end']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /custom after:spec failed/)
          }
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })

    for (const { testName, rejectionVariable, expectedError, enableFailureVideo } of [
      {
        testName: 'reports a failed test session trace when after:spec prevents Cypress after:run',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_SPEC',
        expectedError: /custom after:spec failed/,
        enableFailureVideo: true,
      },
      {
        testName: 'reports a failed test session trace when after:spec rejects without a reason',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_SPEC_WITHOUT_REASON',
        expectedError: /Cypress user handler rejected without an error/,
      },
    ]) {
      over10It(testName, async () => {
        const envVars = getCiVisAgentlessConfig(receiver.port)
        const customHooksConfigFile = type === 'esm'
          ? 'cypress-custom-after-hooks.config.mjs'
          : 'cypress-custom-after-hooks.config.js'
        const startedAt = Date.now()
        const supportDirectory = path.join(cwd, 'cypress', 'support')
        const supportWrappersBefore = getGeneratedSupportFiles(supportDirectory)

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              [rejectionVariable]: '1',
              CYPRESS_ENABLE_FAILURE_VIDEOS: enableFailureVideo ? 'true' : undefined,
              DD_TEST_FAILURE_VIDEOS_ENABLED: enableFailureVideo ? 'true' : undefined,
              SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
            },
          }
        )

        const receiverPromise = receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
              const testSessionTraceEvents = events.filter(event => event.type === eventType)
              assert.strictEqual(testSessionTraceEvents.length, 1, `expected one ${eventType} event`)
              assert.strictEqual(testSessionTraceEvents[0].content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(testSessionTraceEvents[0].content.error, 1)
              assert.match(testSessionTraceEvents[0].content.meta[ERROR_MESSAGE], expectedError)
            }

            const testEvent = events.find(event =>
              event.type === 'test' &&
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assert.ok(testEvent, 'expected completed test event')
            assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
            if (enableFailureVideo) {
              const suiteEvent = events.find(event => event.type === 'test_suite_end')
              for (const event of [testEvent, suiteEvent]) {
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], 'true')
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_SCOPE], VIDEO_UPLOAD_SCOPE_TEST_SUITE)
              }
            }
          },
          { hardTimeout: 60000 }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.notStrictEqual(exitCode, 0)
        assert.ok(Date.now() - startedAt < 20_000, 'final writer flush should remain bounded')
        assert.deepStrictEqual(getGeneratedSupportFiles(supportDirectory), supportWrappersBefore)
      })
    }

    over10It('bounds after:spec error finalization while a screenshot upload is pending', async () => {
      receiver.setMediaResponsesPending()
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'
      const startedAt = Date.now()
      let testOutput = ''

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile} ` +
        '--config screenshotOnRunFailure=true',
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_REJECT_AFTER_SPEC: '1',
            DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true',
            SPEC_PATTERN: 'cypress/e2e/basic-fail.js',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          for (const eventType of ['test_suite_end', 'test']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event\n${testOutput}`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          }
          const suiteEvent = events.find(event => event.type === 'test_suite_end')
          assert.match(suiteEvent.content.meta[ERROR_MESSAGE], /custom after:spec failed/)
        },
        { hardTimeout: 30_000 }
      ).catch((error) => {
        error.message += `\nCypress output:\n${testOutput}`
        throw error
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
      assert.ok(Date.now() - startedAt < 20_000, 'final writer flush should remain bounded')
    })

    // Tests the old manual API: dd-trace/ci/cypress/after-run and after-spec
    // used alongside the manual plugin, without NODE_OPTIONS auto-instrumentation.
    over10It('works if after:run and after:spec are explicitly used with the manual plugin', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
            CYPRESS_ENABLE_MANUAL_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      // TODO: remove this once we have figured out flakiness
      childProcess.stdout?.pipe(process.stdout)
      childProcess.stderr?.pipe(process.stderr)

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEvent)
            const testEvents = events.filter(event => event.type === 'test')
            assert.ok(testEvents.length > 0, `Expected ${testEvents.length} > 0`)
          }, { hardTimeout: 30000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    // Exercises the _isInit=true channel path: NODE_OPTIONS activates auto-instrumentation
    // (wrapSetupNodeEvents), the manual plugin sets _isInit=true, and the channel subscriber
    // chains the after:spec/after:run handlers intercepted by wrappedOn.
    // Differs from the backwards-compat test (APM protocol, single pass) by validating
    // the full citestcycle test session trace through the channel's _isInit=true branch.
    over10It('correctly chains hooks when auto-instrumentation and manual plugin are both active', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      let testOutput = ''

      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_ENABLE_AFTER_SPEC_USER: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
      childProcess.stdout?.on('data', (data) => { testOutput += data })
      childProcess.stderr?.on('data', (data) => { testOutput += data })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const sessionEvents = events.filter(event => event.type === 'test_session_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(sessionEvents.length, 1, 'should have one test session')
            assert.ok(testEvents.length >= 1, 'should have at least one test')

            const passedTest = testEvents.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.match(testOutput, /\[custom:after:spec:manual\]/)
    })

    over10It('keeps same-copy manual tasks when an adapter wraps its lifecycle handlers', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'
      let testOutput = ''

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_SIMULATE_OLD_MANUAL_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
      childProcess.stdout?.on('data', (data) => { testOutput += data })
      childProcess.stderr?.on('data', (data) => { testOutput += data })

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          assert.strictEqual(events.filter(event => event.type === 'test_session_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test_module_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
      assert.doesNotMatch(testOutput, /The task 'dd:/)
      assert.doesNotMatch(testOutput, /Multiple attempts to register the following task/)
    })

    over10It('reports a failed test session trace when a handler after the manual plugin rejects', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_REJECT_AFTER_RUN_AFTER_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          for (const eventType of ['test_session_end', 'test_module_end']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /manual after:run failed after Datadog/)
          }
          const testSuite = events.find(event => event.type === 'test_suite_end')
          assert.ok(testSuite, 'expected test_suite_end event')
          assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSuite.content.error, 0)
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })
  })
})

// Keep browser coverage at real Cypress boundaries; config permutations run in the quick helper job.
{
  const { readFileSync, rmSync, writeFileSync } = fs
  const { join } = path

  const version = process.env.CYPRESS_VERSION || '14.5.4'
  const moduleType = process.env.CYPRESS_MODULE_TYPE || 'commonJS'
  const [cypressMajor, cypressMinor] = version.split('.').map(Number)
  const supportsExperimental = version === 'latest' || cypressMajor > 13 ||
    (cypressMajor === 13 && cypressMinor >= 4)
  // These exclusion scenarios require Cypress 12's test isolation, which makes Datadog retries available.
  // Cypress 6 is only exercised on v5/Node 16 and does not provide that capability.
  const isSupported = version !== '6.7.0' && NODE_MAJOR > 16 &&
    (NODE_MAJOR > 18 || version === '12.0.0' || version === '14.5.4')
  const describeSupported = isSupported ? describe : describe.skip
  const protection = 'test.test_management.prevent_failure_suppression'
  const exclusion = 'test.test_management.no_auto_retry'
  const suite = 'cypress/e2e/test-exclusions.js'

  describeSupported(`Cypress ${version} ${moduleType} v${DD_MAJOR} test automation exclusions`, function () {
    this.timeout(120000)
    const dependencies = getCypressDependencies(version)
    if (process.env.CYPRESS_TEST_BROWSER === 'webkit') dependencies.push('playwright-webkit@1.56.1')
    useSandbox(dependencies, true)
    let cwd, receiver, childProcess, webApp

    before(async function () {
      this.timeout(240000)
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)
      webApp = await startWebAppServer()
    })
    beforeEach(async () => { receiver = await new FakeCiVisIntake().start() })
    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })
    after(async () => { if (webApp) await stopWebAppServer(webApp.server) })

    const properties = assignments => {
      receiver.setTestManagementTests({ cypress: { suites: { [suite]: { tests: assignments } } } })
    }
    const cypressEnvironment = () => {
      const env = getCiVisEvpProxyConfig(receiver.port)
      // This is the matrix selector, not Cypress configuration. Forwarding "latest"
      // overwrites Cypress.version and breaks native version-dependent fixture APIs.
      delete env.CYPRESS_VERSION
      return env
    }
    const run = async (mode, expectedExit, check, env = {}, command) => {
      childProcess = exec(command || (moduleType === 'esm'
        ? 'node ./cypress-esm-config.mjs'
        : `./node_modules/.bin/cypress run --spec ${suite}`), {
        cwd,
        env: {
          ...cypressEnvironment(),
          SPEC_PATTERN: suite,
          CYPRESS_BASE_URL: webApp.baseUrl,
          CYPRESS_EXCLUSIONS_MODE: mode,
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
          ...env,
        },
      })
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const exitPromise = once(childProcess, 'exit')
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const tests = payloads.flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test').map(event => event.content)
          assert.ok(tests.length, output)
          check(tests)
        },
        { hardTimeout: 90000 }
      )
      const [[exitCode]] = await Promise.all([exitPromise, eventsPromise]).catch(error => {
        error.message += `\nCypress output:\n${output}`
        throw error
      })
      assert.strictEqual(exitCode, expectedExit, output)
      return output
    }
    const named = (tests, name) => tests.filter(test => test.meta['test.name'] === name)

    it('protects failures and preserves independent disabled, quarantined, passing and skipped policies', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      const protectedNames = ['protected disabled', 'protected quarantine', 'protected both 1', 'protected both 2']
      const assignments = Object.fromEntries(protectedNames.map(name => [name, {
        properties: {
          disabled: true, quarantined: true, ...(name.startsWith('protected both') ? { attempt_to_fix: true } : {}),
        },
      }]))
      assignments['protected passing'] = { properties: { disabled: true, quarantined: true } }
      assignments['ordinary disabled'] = { properties: { disabled: true, attempt_to_fix: true } }
      assignments['ordinary quarantine'] = { properties: { quarantined: true } }
      assignments['excluded quarantine'] = { properties: { quarantined: true, attempt_to_fix: true } }
      properties(assignments)
      await run('policy', 4, tests => {
        assert.strictEqual(tests.length, 10)
        for (const name of protectedNames) {
          const [test] = named(tests, name)
          assert.strictEqual(test.meta['test.status'], 'fail', name)
          assert.strictEqual(test.meta['test.final_status'], 'fail', name)
          assert.strictEqual(test.meta[protection], 'true', name)
          assert.strictEqual(test.meta[exclusion], name.startsWith('protected both') ? 'true' : undefined, name)
          assert.strictEqual(test.meta['test.test_management.is_test_disabled'], 'true', name)
          assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true', name)
          assert.strictEqual(test.meta['test.is_retry'], undefined, name)
          if (name.startsWith('protected both')) {
            assert.strictEqual(test.meta['test.test_management.is_attempt_to_fix'], 'true', name)
            assert.strictEqual(test.meta['test.test_management.attempt_to_fix_passed'], undefined, name)
          }
        }
        const [disabled] = named(tests, 'ordinary disabled')
        assert.strictEqual(disabled.meta['test.status'], 'skip')
        assert.strictEqual(disabled.meta[exclusion], 'true')
        assert.strictEqual(disabled.meta['test.test_management.is_attempt_to_fix'], 'true')
        for (const name of ['ordinary quarantine', 'excluded quarantine']) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, 1, name)
          assert.strictEqual(attempts[0].meta['test.status'], 'fail', name)
          assert.strictEqual(attempts[0].meta['test.final_status'], 'skip', name)
          assert.strictEqual(attempts[0].meta[protection], undefined, name)
          assert.strictEqual(attempts[0].meta[exclusion], name.startsWith('excluded') ? 'true' : undefined, name)
        }
        assert.strictEqual(named(tests, 'protected passing')[0].meta['test.status'], 'pass')
        assert.strictEqual(named(tests, 'ordinary passing')[0].meta[protection], undefined)
        assert.strictEqual(named(tests, 'ordinary passing')[0].meta[exclusion], undefined)
        const [skipped] = named(tests, 'developer skipped')
        assert.strictEqual(skipped.meta['test.status'], 'skip')
        assert.strictEqual(skipped.meta[protection], 'true')
        assert.strictEqual(skipped.meta[exclusion], 'true')
        const executed = Object.fromEntries([...protectedNames, 'ordinary quarantine', 'excluded quarantine',
          'protected passing', 'ordinary passing'].map(name => [name, 1]))
        assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'exclusion-executions.json'), 'utf8')), executed)
      })
    })

    it('blocks ATR without preventing protected retries or changing unannotated controls', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('atr', 2, tests => {
        assert.strictEqual(tests.length, 6)
        const [excluded] = named(tests, 'excluded')
        assert.strictEqual(named(tests, 'excluded').length, 1)
        assert.strictEqual(excluded.meta[exclusion], 'true')
        assert.strictEqual(excluded.meta['test.is_retry'], undefined)
        assert.strictEqual(named(tests, 'control').length, 3)
        assert.strictEqual(named(tests, 'protected retry').length, 2)
        assert.strictEqual(named(tests, 'protected retry').at(-1).meta['test.status'], 'pass')
      })
    })

    for (const feature of ['efd', 'atf']) {
      it(`blocks ${feature} while preserving discovery and assigned properties`, async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          known_tests_enabled: feature === 'efd',
          early_flake_detection: {
            enabled: feature === 'efd', slow_test_retries: { '5s': 2 }, faulty_session_threshold: 100,
          },
          test_management: { enabled: feature === 'atf', attempt_to_fix_retries: 2 },
        })
        receiver.setKnownTests({ cypress: { 'cypress/e2e/known.js': ['known'] } })
        properties({
          excluded: { properties: { attempt_to_fix: true } },
          control: { properties: { attempt_to_fix: true } },
        })
        await run(feature, 0, tests => {
          assert.strictEqual(tests.length, 4)
          const [excluded] = named(tests, 'excluded')
          assert.strictEqual(named(tests, 'excluded').length, 1)
          assert.strictEqual(named(tests, 'control').length, 3)
          assert.strictEqual(excluded.meta[exclusion], 'true')
          assert.strictEqual(excluded.meta['test.is_retry'], undefined)
          assert.strictEqual(excluded.meta['test.test_management.attempt_to_fix_passed'], undefined)
          if (feature === 'efd') assert.strictEqual(excluded.meta['test.is_new'], 'true')
          if (feature === 'atf') assert.strictEqual(excluded.meta['test.test_management.is_attempt_to_fix'], 'true')
        })
      })
    }

    it('preserves global, suite and test native retries, including explicit zero, with ATR enabled', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native', 1, tests => {
        for (const [name, count] of [['global native', 3], ['suite native suite retry', 2], ['test native', 2],
          ['native zero', 1]]) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, count, name)
          assert.strictEqual(attempts.at(-1).meta['test.status'], name === 'native zero' ? 'fail' : 'pass', name)
          for (const test of attempts) assert.strictEqual(test.meta[exclusion], 'true', name)
          for (const test of attempts.slice(1)) assert.strictEqual(test.meta['test.retry_reason'], 'external', name)
        }
        assert.strictEqual(tests.length, 8)
      }, { CYPRESS_RETRIES: '2' })
    })

    // Detailed config permutations run in config-lifecycle.spec.js without starting Cypress.
    // Keep real IPC, manual support ordering and cross-spec reuse at the browser boundary.
    for (const lateMode of ['indirect-returned-support', 'browser-equal-before-support-reuse-preloaded']) {
      it(`preserves native retries through ${lateMode}`, async () => {
        const command = './node_modules/.bin/cypress run ' +
          '--config-file ci-visibility/cypress-late-native-retries/config.js'
        const ledger = join(cwd, 'late-native-retry-executions.json')
        const expected = {
          'late native excluded': 3,
          'late native control': 3,
          'explicit local excluded': 2,
          ...(lateMode.includes('-reuse') && { 'support reuse smoke': 1 }),
        }
        childProcess = exec(command, {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            CYPRESS_LATE_NATIVE_RETRIES_MODE: lateMode,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        assert.strictEqual(nativeExit, 0, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: true })
        await run('late-native', 0, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const [name, count] of Object.entries(expected)) {
            const attempts = named(tests, name)
            assert.strictEqual(attempts.length, count, name)
            assert.strictEqual(attempts.at(-1).meta['test.status'], 'pass', name)
            assert.strictEqual(attempts[0].meta[exclusion], name === 'late native control' ? undefined : 'true', name)
            if (lateMode.includes('indirect')) {
              for (const attempt of attempts) assert.strictEqual(attempt.meta['manual.early_teardown'], 'preserved')
            }
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'],
                name === 'late native control' ? 'auto_test_retry' : 'external', name)
            }
          }
        }, {
          ...(lateMode.endsWith('-preloaded') ? {} : { NODE_OPTIONS: '' }),
          CYPRESS_LATE_NATIVE_RETRIES_MODE: lateMode,
        }, command)
      })
    }

    for (const mode of ['browser-field-accessor', 'experimental-native-field-accessor', 'browser-saved-local']) {
      const experimentalMode = mode === 'experimental-native-field-accessor'
      const fieldAccessor = mode !== 'browser-saved-local'
      // Cypress <15.17 retains the restoration callback across tests without overrides.
      const legacySavedLocal = !fieldAccessor && version !== 'latest' &&
        (cypressMajor < 15 || (cypressMajor === 15 && cypressMinor < 17))
      const boundaryTest = experimentalMode && !supportsExperimental ? it.skip : it
      boundaryTest(`preserves ${mode} native retry executions`, async () => {
        const boundarySuite = 'cypress/e2e/native-retry-boundaries.cy.js'
        const ledger = join(cwd, 'native-retry-executions.json')
        const expected = {
          ...(!fieldAccessor && {
            'initial local control': 1, 'captures local retries': 1, 'restores local retries': 1,
          }),
          'excluded recovery': legacySavedLocal ? 1 : experimentalMode ? 4 : 3,
          'excluded persistent': legacySavedLocal ? 1 : fieldAccessor ? 4 : 3,
          'excluded explicit zero': 1,
          'ordinary control': legacySavedLocal ? 1 : experimentalMode ? 4 : 3,
        }
        const env = experimentalMode ? { CYPRESS_EXPERIMENTAL_RETRIES: 'true' } : {}
        const command = `./node_modules/.bin/cypress run --spec ${boundarySuite}`
        childProcess = exec(`${command} --config supportFile=false`, {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            SPEC_PATTERN: boundarySuite,
            CYPRESS_EXCLUSIONS_MODE: mode,
            CYPRESS_MATCHED_NATIVE_HOOKS: fieldAccessor ? 'true' : undefined,
            ...env,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        const accessorReads = fieldAccessor
          ? JSON.parse(readFileSync(join(cwd, 'native-retry-accessor-reads.json'), 'utf8'))
          : undefined
        assert.strictEqual(nativeExit, legacySavedLocal || experimentalMode ? 4 : 2, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: true })
        if (legacySavedLocal) expected['ordinary control'] = 3
        await run(mode, legacySavedLocal ? 3 : experimentalMode ? 4 : 2, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          if (accessorReads) {
            assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'native-retry-accessor-reads.json'), 'utf8')),
              accessorReads)
          }
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const [name, count] of Object.entries(expected)) {
            const attempts = named(tests, `native retry boundaries ${name}`)
            assert.strictEqual(attempts.length, count, name)
            const annotated = name.startsWith('excluded')
            const failed = name === 'excluded persistent' || name === 'excluded explicit zero' ||
              (legacySavedLocal && name === 'excluded recovery')
            assert.strictEqual(attempts.at(-1).meta['test.status'], failed ? 'fail' : 'pass', name)
            if (experimentalMode) assert.strictEqual(attempts.at(-1).meta['test.final_status'], 'fail', name)
            for (const test of attempts) assert.strictEqual(test.meta[exclusion], annotated ? 'true' : undefined, name)
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'], annotated ? 'external' : 'auto_test_retry', name)
            }
          }
        }, { SPEC_PATTERN: boundarySuite, ...env, DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '4' }, command)
      })
    }

    it('keeps a sole protected failure blocking', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
      properties({ sole: { properties: { disabled: true, quarantined: true, attempt_to_fix: true } } })
      await run('sole', 1, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'fail')
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], 'true')
      })
    })

    it('preserves Test Impact Analysis selection on an annotated test', async () => {
      receiver.setSettings({ itr_enabled: true, tests_skipping: true })
      receiver.setSuitesToSkip([{ type: 'test', attributes: { suite, name: 'sole' } }])
      await run('sole', 0, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'skip')
        assert.strictEqual(tests[0].meta['test.skipped_by_itr'], 'true')
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], 'true')
      })
    })

    it('reports protected and ordinary ATF assignments when every declaration is explicitly skipped', async () => {
      receiver.setSettings({ test_management: { enabled: true } })
      properties(Object.fromEntries(['protected skipped atf', 'ordinary skipped atf'].map(name => [name, {
        properties: { disabled: true, quarantined: true, attempt_to_fix: true },
      }])))
      const output = await run('all-skipped', 0, tests => {
        assert.strictEqual(tests.length, 3)
        const [both] = named(tests, 'annotated skip')
        assert.strictEqual(both.meta[protection], 'true')
        assert.strictEqual(both.meta[exclusion], 'true')
        for (const name of ['protected skipped atf', 'ordinary skipped atf']) {
          const [test] = named(tests, name)
          assert.strictEqual(test.meta['test.status'], 'skip', name)
          assert.strictEqual(test.meta['test.final_status'], 'skip', name)
          assert.strictEqual(test.meta[protection], name.startsWith('protected') ? 'true' : undefined, name)
          for (const flag of ['is_test_disabled', 'is_quarantined', 'is_attempt_to_fix']) {
            assert.strictEqual(test.meta[`test.test_management.${flag}`], 'true', name)
          }
        }
      }, { DD_TEST_MANAGEMENT_REPORT_ENABLED: 'true' })
      assert.match(output, /Attempt to fix passed/)
      for (const flag of ['disabled', 'quarantined']) assert.ok(output.includes(`marked as ${flag}`))
    })

    // Experimental strategy configuration was added in Cypress13.4.
    const experimental = supportsExperimental ? it : it.skip
    experimental('preserves experimental budgets, zero overrides and aggregate failure',
      async () => {
        receiver.setSettings({ flaky_test_retries_enabled: false })
        await run('experimental', 4, tests => {
          assert.strictEqual(tests.length, 10)
          for (const name of [
            'native experimental excluded', 'native experimental control', 'native experimental recovery',
          ]) {
            const attempts = named(tests, name)
            assert.strictEqual(attempts.length, 3, name)
            for (const test of attempts) {
              assert.strictEqual(test.meta[exclusion], name.endsWith('control') ? undefined : 'true', name)
            }
            for (const retry of attempts.slice(1)) assert.strictEqual(retry.meta['test.retry_reason'], 'external', name)
            assert.strictEqual(attempts.at(-1).meta['test.status'], name.endsWith('recovery') ? 'pass' : 'fail', name)
            assert.strictEqual(attempts.at(-1).meta['test.final_status'], 'fail', name)
          }
          const zero = named(tests, 'native experimental zero')
          assert.strictEqual(zero.length, 1)
          assert.strictEqual(zero[0].meta[exclusion], 'true')
        }, { CYPRESS_EXPERIMENTAL_RETRIES: 'true' })
      })

    it('preserves declarations, duplicate order, source locations and pending callbacks',
      async () => {
        const pendingSuite = 'cypress/e2e/annotation-declarations.js'
        const pendingLedger = join(cwd, 'pending-suite-executions.json')
        const collector = createServer((request, response) => {
          response.setHeader('Access-Control-Allow-Origin', '*')
          if (request.url !== '/pending-counter' || request.method !== 'POST') {
            response.writeHead(404).end()
            return
          }
          let body = ''
          request.setEncoding('utf8')
          request.on('data', chunk => { body += chunk })
          request.on('end', () => {
            writeFileSync(pendingLedger, body)
            response.writeHead(200).end('recorded')
          })
        })
        await new Promise((resolve, reject) => {
          collector.once('error', reject)
          collector.listen(0, '127.0.0.1', resolve)
        })
        const address = /** @type {import('node:net').AddressInfo} */ (collector.address())
        const ledgerUrl = `http://127.0.0.1:${address.port}/pending-counter`
        try {
          const browserOption = process.env.CYPRESS_TEST_BROWSER ? ' --browser "$CYPRESS_TEST_BROWSER"' : ''
          const webkit = process.env.CYPRESS_TEST_BROWSER === 'webkit'
          const nativeConfig = webkit ? 'supportFile=false,experimentalWebKitSupport=true' : 'supportFile=false'
          const tracingConfig = webkit ? ' --config experimentalWebKitSupport=true' : ''
          const nativeCommand = `./node_modules/.bin/cypress run --spec ${pendingSuite}` +
          ` --config ${nativeConfig}${browserOption}`
          childProcess = exec(nativeCommand, {
            cwd,
            env: {
              ...cypressEnvironment(),
              NODE_OPTIONS: '',
              DD_TRACE_ENABLED: 'false',
              SPEC_PATTERN: pendingSuite,
              CYPRESS_EXCLUSIONS_MODE: 'pending-suite',
              CYPRESS_PENDING_LEDGER_URL: ledgerUrl,
            },
          })
          let output = ''
          childProcess.stdout.on('data', chunk => { output += chunk })
          childProcess.stderr.on('data', chunk => { output += chunk })
          const [exitCode] = await once(childProcess, 'exit')
          assert.strictEqual(exitCode, 0, output)
          assert.match(output, /6 passing/)
          assert.match(output, /35 pending/)
          assert.doesNotMatch(output, /skipped callback executed/)
          assert.deepStrictEqual(JSON.parse(readFileSync(pendingLedger, 'utf8')), { skipped: 0, executed: 1 })
          rmSync(pendingLedger)

          await run('pending-suite', 0, tests => {
            assert.strictEqual(tests.length, 41)
            const skipped = tests.filter(test => test.meta['test.status'] === 'skip' &&
            !test.meta['test.name'].includes('duplicate declaration'))
            assert.strictEqual(skipped.length, 28)
            assert.deepStrictEqual(JSON.parse(readFileSync(pendingLedger, 'utf8')), { skipped: 0, executed: 1 })
            for (const test of skipped) {
              const name = test.meta['test.name']
              const both = name.endsWith('both flags') || name.endsWith('nested skip flags')
              assert.strictEqual(test.meta[protection],
                both || name.endsWith('protected flag') ? 'true' : undefined, name)
              assert.strictEqual(test.meta[exclusion], both || name.endsWith('retry flag') ? 'true' : undefined, name)
            }
            for (const mode of ['duplicate-skipped', 'duplicate-mixed', 'duplicate-skipped-first']) {
              const duplicate = named(tests, `${mode} duplicate declaration`)
              assert.strictEqual(duplicate.length, 3, mode)
              const actual = duplicate.map(test => JSON.stringify([
                test.meta['test.status'], test.meta[protection], test.meta[exclusion],
              ])).sort()
              const expected = [
                [mode === 'duplicate-skipped' ? 'skip' : 'pass', 'true', undefined],
                ['skip', undefined, 'true'], ['skip', undefined, undefined],
              ].map(test => JSON.stringify(test)).sort()
              assert.deepStrictEqual(actual, expected, mode)
            }
            for (const name of ['ordinary declaration source', 'annotated declaration source', 'mode selected']) {
              const [test] = named(tests, name)
              assert.strictEqual(test.meta['test.status'], 'pass', name)
              assert.strictEqual(test.meta[exclusion], name.startsWith('ordinary') ? undefined : 'true', name)
            }
            const [executed] = named(tests, 'execution after pending declarations')
            assert.strictEqual(executed.meta['test.status'], 'pass')
          }, { SPEC_PATTERN: pendingSuite, CYPRESS_PENDING_LEDGER_URL: ledgerUrl },
        `./node_modules/.bin/cypress run --spec ${pendingSuite}${tracingConfig}${browserOption}`)
        } finally {
          await new Promise(resolve => collector.close(resolve))
        }
      })

    it('keeps manually loaded support harmless when tracing is disabled', async () => {
      childProcess = exec(
        './node_modules/.bin/cypress run --config-file ci-visibility/cypress-exclusions-manual/config.js', {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            CYPRESS_ROOT_SETUP_MODE: 'skip',
          },
        }
      )
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const [exitCode] = await once(childProcess, 'exit')
      assert.strictEqual(exitCode, 0, output)
      assert.doesNotMatch(output, /task.*was not handled/)
    })

    for (const mode of ['fail', 'skip']) {
      it(`reports annotations when an earlier root setup hook must ${mode}`, async () => {
        await run(mode, mode === 'fail' ? 1 : 0, tests => {
          assert.strictEqual(tests.length, 2)
          const [annotated] = named(tests, 'annotated setup skip')
          const [control] = named(tests, 'ordinary setup skip')
          assert.strictEqual(annotated.meta['test.status'], 'skip')
          assert.strictEqual(annotated.meta[protection], 'true')
          assert.strictEqual(annotated.meta[exclusion], 'true')
          assert.strictEqual(control.meta['test.status'], 'skip')
          assert.strictEqual(control.meta[protection], undefined)
          assert.strictEqual(control.meta[exclusion], undefined)
        }, { NODE_OPTIONS: '', CYPRESS_ROOT_SETUP_MODE: mode },
        './node_modules/.bin/cypress run --config-file ci-visibility/cypress-exclusions-manual/config.js')
      })
    }
    it('restores native partial JSON retry counts without an extra attempt', async () => {
      const command = './node_modules/.bin/cypress run ' +
        '--config-file ci-visibility/cypress-late-native-retries/config.js'
      const ledger = join(cwd, 'late-native-retry-executions.json')
      const reads = join(cwd, 'returned-retry-json-reads.json')
      const expected = { 'late native excluded': 5, 'late native control': 5, 'explicit local excluded': 2 }
      childProcess = exec(command, {
        cwd,
        env: {
          ...cypressEnvironment(),
          NODE_OPTIONS: '',
          DD_TRACE_ENABLED: 'false',
          CYPRESS_LATE_NATIVE_RETRIES_MODE: 'returned-json',
        },
      })
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const [exitCode] = await once(childProcess, 'exit')
      assert.strictEqual(exitCode, 3, output)
      assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
      assert.deepStrictEqual(JSON.parse(readFileSync(reads, 'utf8')), { reads: 1 })
      rmSync(ledger)
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('returned-json', 3, tests => {
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
        assert.deepStrictEqual(JSON.parse(readFileSync(reads, 'utf8')), { reads: 1 })
        assert.strictEqual(tests.length, 12)
        for (const test of tests) {
          assert.strictEqual(test.meta['test.status'], 'fail')
          assert.strictEqual(test.meta[exclusion],
            test.meta['test.name'] === 'late native control' ? undefined : 'true')
        }
      }, { CYPRESS_LATE_NATIVE_RETRIES_MODE: 'returned-json', DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '4' }, command)
    })
  })
}
