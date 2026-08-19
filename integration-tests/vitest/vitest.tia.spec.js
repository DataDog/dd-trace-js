'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { inspect } = require('node:util')

const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const {
  TEST_STATUS,
  TEST_FRAMEWORK_VERSION,
  TEST_SUITE,
  TEST_SKIPPED_BY_ITR,
  TEST_ITR_TESTS_SKIPPED,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  TEST_CODE_COVERAGE_ENABLED,
  ITR_CORRELATION_ID,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  TELEMETRY_CODE_COVERAGE_STARTED,
  TELEMETRY_CODE_COVERAGE_FINISHED,
  TELEMETRY_ITR_UNSKIPPABLE,
  TELEMETRY_ITR_FORCED_TO_RUN,
  TELEMETRY_CODE_COVERAGE_NUM_FILES,
} = require('../../packages/dd-trace/src/ci-visibility/telemetry')
const { NODE_MAJOR } = require('../../version')

const CUSTOM_SEQUENCER_MARKER = 'dd-trace custom vitest sequencer was used'

// vitest@4.x requires Node.js >= 20
const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']

versions.forEach((version) => {
  describe(`vitest@${version}`, () => {
    let cwd, receiver, childProcess, testOutput
    const legacyVitestIt = version === '1.6.0' ? it : it.skip
    const newerVitestIt = version === '1.6.0' ? it.skip : it

    useSandbox([
      `vitest@${version}`,
      `@vitest/coverage-istanbul@${version}`,
      `@vitest/coverage-v8@${version}`,
      '@types/node',
      'tinypool',
      'typescript@6.0.3',
    ], true)

    before(function () {
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      testOutput = ''
      childProcess.kill()
      await receiver.stop()
    })

    context('test impact analysis', () => {
      const firstSuite = 'ci-visibility/vitest-tests/tia-first.mjs'
      const secondSuite = 'ci-visibility/vitest-tests/tia-second.mjs'
      const settingsUrl = '/api/v2/libraries/tests/services/setting'
      const skippableUrl = '/api/v2/ci/tests/skippable'
      const tiaRequestFilter = ({ url }) =>
        url === '/api/v2/citestcycle' ||
        url === '/api/v2/citestcov' ||
        url === settingsUrl ||
        url === skippableUrl ||
        url.endsWith('/api/v2/apmtelemetry')

      function getTiaSettings (overrides = {}) {
        return {
          itr_enabled: true,
          code_coverage: true,
          coverage_report_upload_enabled: false,
          tests_skipping: true,
          ...overrides,
        }
      }

      function runTiaTests (assertPayloads, options = {}) {
        const {
          command = './node_modules/.bin/vitest run',
          coverageProvider,
          currentWorkingDirectory = cwd,
          env = {},
          requestFilter = ({ url }) => url === '/api/v2/citestcycle' || url === '/api/v2/citestcov',
          testOptimizationEnvironment = getCiVisAgentlessConfig(receiver.port),
        } = options
        const coverageArgument = coverageProvider ? ' --coverage' : ''
        childProcess = exec(`${command}${coverageArgument}`, {
          cwd: currentWorkingDirectory,
          env: {
            ...testOptimizationEnvironment,
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: 'ci-visibility/vitest-tests/tia-{first,second}.mjs',
            COVERAGE_PROVIDER: coverageProvider,
            ...env,
          },
        })

        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        return receiver.gatherPayloadsUntilChildExit(
          childProcess,
          requestFilter,
          assertPayloads,
          { hardTimeout: 60_000 }
        )
      }

      function getTiaPayloads (payloads) {
        const events = payloads
          .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
          .flatMap(({ payload }) => payload.events)
        const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
        const suiteById = new Map(testSuiteEvents.map(({ content }) => [
          Number(content.test_suite_id),
          content.meta[TEST_SUITE],
        ]))
        const coverages = payloads
          .filter(({ url }) => url.endsWith('/api/v2/citestcov'))
          .flatMap(({ payload }) => payload)
          .flatMap(({ content }) => content.coverages)
        const coverageBySuite = new Map(coverages.map(coverage => [
          suiteById.get(coverage.test_suite_id),
          coverage.files.map(({ filename }) => filename).sort(),
        ]))
        const coverageDetails = coverages.map(coverage => ({
          coverage,
          suite: suiteById.get(coverage.test_suite_id),
        }))

        return { events, testSuiteEvents, coverages, coverageBySuite, coverageDetails }
      }

      it('reports covered files per test suite without a user coverage dependency', async () => {
        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages, coverageBySuite } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(coverages.length, 2, testOutput)
          assert.strictEqual(
            new Set(coverages.map(coverage => coverage.test_suite_id)).size,
            2,
            testOutput
          )
          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.deepStrictEqual(
            coverageBySuite.get(secondSuite),
            ['ci-visibility/vitest-tests/bad-sum.mjs', secondSuite].sort()
          )
          assert.ok(coverages.every(coverage =>
            coverage.files.every(file => !Object.hasOwn(file, 'bitmap'))
          ))
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports setup files and their dependencies without a user coverage dependency', async () => {
        const setupFile = 'ci-visibility/vitest-tests/tia-setup.mjs'
        const setupSource = 'ci-visibility/vitest-tests/tia-setup-source.mjs'

        await runTiaTests((payloads) => {
          const { coverageBySuite } = getTiaPayloads(payloads)

          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [
              firstSuite,
              'ci-visibility/vitest-tests/sum.mjs',
              setupFile,
              setupSource,
            ].sort()
          )
        }, {
          env: {
            TEST_DIR: firstSuite,
            VITEST_SETUP_FILE: setupFile,
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports dynamic imports and mocked implementations with isolation disabled', async () => {
        const testSuite = 'ci-visibility/vitest-tests/tia-dynamic-mock.mjs'
        const dynamicSource = 'ci-visibility/vitest-tests/tia-dynamic-source.mjs'
        const mockedImplementation = 'ci-visibility/vitest-tests/tia-mocked-implementation.mjs'
        const mockedTarget = 'ci-visibility/vitest-tests/tia-mocked-target.mjs'

        await runTiaTests((payloads) => {
          const { coverageBySuite } = getTiaPayloads(payloads)
          const coverage = coverageBySuite.get(testSuite)

          assert.ok(coverage, testOutput)
          assert.ok(coverage.includes(testSuite), testOutput)
          assert.ok(coverage.includes(dynamicSource), testOutput)
          assert.ok(coverage.includes(mockedImplementation), testOutput)
          assert.strictEqual(coverage.includes(mockedTarget), false, testOutput)
        }, {
          command: './node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism',
          env: {
            NO_ISOLATE: 'true',
            TEST_DIR: testSuite,
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports workspace sources imported through preserved node_modules symlinks', async () => {
        const testSuite = 'ci-visibility/vitest-tests/tia-workspace-symlink.mjs'
        const workspaceSource = 'ci-visibility/vitest-workspace-package/source.mjs'
        const workspacePackage = path.join(cwd, 'ci-visibility/vitest-workspace-package')
        const workspaceLink = path.join(cwd, 'node_modules/tia-workspace-package')

        fs.symlinkSync(workspacePackage, workspaceLink, 'dir')
        try {
          await runTiaTests((payloads) => {
            const { coverageBySuite } = getTiaPayloads(payloads)

            assert.deepStrictEqual(
              coverageBySuite.get(testSuite),
              [testSuite, workspaceSource].sort()
            )
          }, {
            env: {
              NODE_OPTIONS: '--preserve-symlinks --import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: testSuite,
              VITEST_PRESERVE_SYMLINKS: '1',
            },
          })
        } finally {
          fs.rmSync(workspaceLink, { force: true })
        }

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      for (const coverageProvider of ['v8', 'istanbul']) {
        it(`reports per-suite covered files when the user enables ${coverageProvider} coverage`, async () => {
          await runTiaTests((payloads) => {
            const { coverageBySuite } = getTiaPayloads(payloads)

            assert.deepStrictEqual(
              coverageBySuite.get(firstSuite),
              [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
            )
            assert.deepStrictEqual(
              coverageBySuite.get(secondSuite),
              ['ci-visibility/vitest-tests/bad-sum.mjs', secondSuite].sort()
            )
          }, { coverageProvider })

          assert.strictEqual(childProcess.exitCode, 0, testOutput)
        })
      }

      it('does not apply user Istanbul include filters to per-suite TIA coverage', async () => {
        await runTiaTests((payloads) => {
          const { coverageBySuite } = getTiaPayloads(payloads)

          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.deepStrictEqual(
            coverageBySuite.get(secondSuite),
            ['ci-visibility/vitest-tests/bad-sum.mjs', secondSuite].sort()
          )
        }, {
          coverageProvider: 'istanbul',
          env: {
            COVERAGE_INCLUDE: firstSuite,
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      for (const inspectorFailure of ['connect', 'take']) {
        it(`does not report incomplete coverage when inspector ${inspectorFailure} fails`, async () => {
          await runTiaTests((payloads) => {
            const { testSuiteEvents, coverages } = getTiaPayloads(payloads)

            assert.strictEqual(testSuiteEvents.length, 2, testOutput)
            assert.strictEqual(coverages.length, 0, testOutput)
          }, {
            env: {
              NODE_OPTIONS:
                '--import dd-trace/register.js -r dd-trace/ci/init -r ./ci-visibility/vitest-block-inspector.cjs',
              VITEST_INSPECTOR_FAILURE: inspectorFailure,
            },
          })

          assert.strictEqual(childProcess.exitCode, 0, testOutput)
        })
      }

      it('skips suites returned by TIA and reports the skipped suite', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: secondSuite,
          },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content
          const runningSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === firstSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(
            skippedSuite.meta[TEST_FRAMEWORK_VERSION],
            runningSuite.meta[TEST_FRAMEWORK_VERSION]
          )
          assert.strictEqual(skippedSuite[ITR_CORRELATION_ID], '1234')
          assert.strictEqual(runningSuite[ITR_CORRELATION_ID], '1234')
          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.strictEqual(coverageBySuite.has(secondSuite), false)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_TYPE], 'suite')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
        assert.strictEqual(testOutput.includes(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE), false, testOutput)
      })

      it('skips suites with missing line coverage when coverage report upload is enabled', async () => {
        receiver.setSettings(getTiaSettings({ coverage_report_upload_enabled: true }))
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: secondSuite,
            _is_missing_line_code_coverage: true,
          },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content

          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
        }, { requestFilter: tiaRequestFilter })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports a skipped session and exits successfully when every suite is skipped', async () => {
        receiver.setSuitesToSkip([firstSuite, secondSuite].map(suite => ({
          type: 'suite',
          attributes: { suite },
        })))

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_STATUS] === 'skip'))
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_SKIPPED_BY_ITR] === 'true'))
          assert.strictEqual(events.some(event => event.type === 'test'), false)
          assert.strictEqual(coverageBySuite.size, 0)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 2)
          assert.strictEqual(testModule.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 2)
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
        assert.strictEqual(
          testOutput.split(TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE).length - 1,
          1,
          testOutput
        )
      })

      it('does not request skippable suites or report coverage when TIA is disabled', async () => {
        receiver.setSettings(getTiaSettings({
          itr_enabled: false,
          code_coverage: false,
          tests_skipping: false,
        }))
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(payloads.filter(({ url }) => url === settingsUrl).length, 1)
          assert.strictEqual(payloads.some(({ url }) => url === skippableUrl), false)
          assert.strictEqual(coverages.length, 0)
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 2)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
          assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        }, { requestFilter: tiaRequestFilter })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('skips suites without reporting coverage when coverage is disabled', async () => {
        receiver.setSettings(getTiaSettings({ code_coverage: false }))
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(payloads.filter(({ url }) => url === skippableUrl).length, 1)
          assert.strictEqual(coverages.length, 0)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, { requestFilter: tiaRequestFilter })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports coverage without requesting or skipping suites when skipping is disabled', async () => {
        receiver.setSettings(getTiaSettings({ tests_skipping: false }))
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(payloads.some(({ url }) => url === skippableUrl), false)
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 2)
          assert.strictEqual(coverages.length, 2)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
        }, { requestFilter: tiaRequestFilter })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('forces an unskippable suite to run and reports its TIA tags', async () => {
        const suitePrefix = 'ci-visibility/vitest-tests/tia-unskippable-'
        const suiteToRun = `${suitePrefix}to-run.mjs`
        const suiteToSkip = `${suitePrefix}to-skip.mjs`
        const unskippableSuite = `${suitePrefix}marked.mjs`
        receiver.setSuitesToSkip([suiteToSkip, unskippableSuite].map(suite => ({
          type: 'suite',
          attributes: { suite },
        })))

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          const suites = new Map(testSuiteEvents.map(({ content }) => [content.meta[TEST_SUITE], content]))

          assert.strictEqual(testSuiteEvents.length, 3, testOutput)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 2)
          assert.strictEqual(suites.get(suiteToRun).meta[TEST_STATUS], 'pass')
          assert.strictEqual(suites.get(suiteToSkip).meta[TEST_STATUS], 'skip')
          assert.strictEqual(suites.get(suiteToSkip).meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(suites.get(unskippableSuite).meta[TEST_STATUS], 'pass')
          assert.strictEqual(suites.get(unskippableSuite).meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(suites.get(unskippableSuite).meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(testSession.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_FORCED_RUN], 'true')
          assert.strictEqual(coverageBySuite.has(suiteToSkip), false)
          assert.strictEqual(coverageBySuite.has(unskippableSuite), true)
        }, {
          env: {
            TEST_DIR: 'ci-visibility/vitest-tests/tia-unskippable-*.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('marks an unskippable suite without marking it forced when it is not a skip candidate', async () => {
        const suitePrefix = 'ci-visibility/vitest-tests/tia-unskippable-'
        const suiteToSkip = `${suitePrefix}to-skip.mjs`
        const unskippableSuite = `${suitePrefix}marked.mjs`
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: suiteToSkip },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content
          const suite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === unskippableSuite).content

          assert.strictEqual(suite.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(Object.hasOwn(suite.meta, TEST_ITR_FORCED_RUN), false)
          assert.strictEqual(testSession.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(Object.hasOwn(testSession.meta, TEST_ITR_FORCED_RUN), false)
          assert.strictEqual(testModule.meta[TEST_ITR_UNSKIPPABLE], 'true')
          assert.strictEqual(Object.hasOwn(testModule.meta, TEST_ITR_FORCED_RUN), false)
        }, {
          env: {
            TEST_DIR: 'ci-visibility/vitest-tests/tia-unskippable-*.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports transformed TypeScript source files without a coverage dependency', async () => {
        const typeScriptSuite = 'ci-visibility/vitest-tests/tia-typescript.test.ts'

        await runTiaTests((payloads) => {
          const { testSuiteEvents, coverages, coverageBySuite } = getTiaPayloads(payloads)

          assert.strictEqual(testSuiteEvents.length, 1, testOutput)
          assert.strictEqual(coverages.length, 1)
          assert.deepStrictEqual(
            coverageBySuite.get(typeScriptSuite),
            [
              typeScriptSuite,
              'ci-visibility/vitest-tests/tia-typescript-source.ts',
            ].sort()
          )
        }, {
          env: {
            TEST_DIR: typeScriptSuite,
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports repository-relative paths when Vitest runs below the repository root', async () => {
        const subprojectDirectory = path.join(cwd, 'ci-visibility/vitest-tests/subproject')
        const subprojectSuite = 'ci-visibility/vitest-tests/subproject/tia-subproject.test.ts'

        await runTiaTests((payloads) => {
          const { testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)

          assert.strictEqual(testSuiteEvents.length, 1, testOutput)
          assert.deepStrictEqual(
            coverageBySuite.get(subprojectSuite),
            [
              subprojectSuite,
              'ci-visibility/vitest-tests/subproject/tia-subproject-source.ts',
            ].sort()
          )
        }, {
          command: '../../../node_modules/.bin/vitest run --config ../../../vitest.config.mjs',
          currentWorkingDirectory: subprojectDirectory,
          env: {
            TEST_DIR: './tia-subproject.test.ts',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('normalizes Windows separators in backend skip candidates', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: secondSuite.replaceAll('/', '\\'),
          },
        }])

        await runTiaTests((payloads) => {
          const { testSuiteEvents } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content

          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('does not mark the session skipped for a candidate that does not exist', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: {
            suite: 'ci-visibility/vitest-tests/tia-does-not-exist.mjs',
          },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 0)
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports per-suite coverage with the threads pool', async () => {
        await runTiaTests((payloads) => {
          const { coverageBySuite } = getTiaPayloads(payloads)

          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.deepStrictEqual(
            coverageBySuite.get(secondSuite),
            ['ci-visibility/vitest-tests/bad-sum.mjs', secondSuite].sort()
          )
        }, {
          env: {
            POOL_CONFIG: 'threads',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports TIA payloads through the event platform proxy', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents
            .find(({ content }) => content.meta[TEST_SUITE] === secondSuite)
            .content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const urls = payloads.map(({ url }) => url)

          assert.ok(urls.some(url => url.endsWith('/api/v2/libraries/tests/services/setting')))
          assert.ok(urls.some(url => url.endsWith('/api/v2/ci/tests/skippable')))
          assert.ok(urls.some(url => url.endsWith('/api/v2/citestcov')))
          assert.ok(urls.every(url => url.startsWith('/evp_proxy/')), inspect(urls))
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.strictEqual(coverageBySuite.has(secondSuite), false)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, {
          testOptimizationEnvironment: getCiVisEvpProxyConfig(receiver.port),
          requestFilter: ({ url }) =>
            url.endsWith('/api/v2/libraries/tests/services/setting') ||
            url.endsWith('/api/v2/ci/tests/skippable') ||
            url.endsWith('/api/v2/citestcycle') ||
            url.endsWith('/api/v2/citestcov'),
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('does not request TIA when the agent does not support the event platform proxy', async () => {
        receiver.setInfoResponse({ endpoints: [] })

        await runTiaTests((payloads) => {
          const urls = payloads.map(({ url }) => url)

          assert.ok(urls.includes('/v0.4/traces'), inspect(urls))
          assert.strictEqual(
            urls.some(url =>
              url.endsWith('/api/v2/libraries/tests/services/setting') ||
              url.endsWith('/api/v2/ci/tests/skippable') ||
              url.endsWith('/api/v2/citestcov')
            ),
            false,
            inspect(urls)
          )
        }, {
          testOptimizationEnvironment: getCiVisEvpProxyConfig(receiver.port),
          requestFilter: ({ url }) =>
            url === '/v0.4/traces' ||
            url.endsWith('/api/v2/libraries/tests/services/setting') ||
            url.endsWith('/api/v2/ci/tests/skippable') ||
            url.endsWith('/api/v2/citestcov'),
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('does not request skippable suites when git metadata upload fails', async () => {
        receiver.setGitUploadStatus(404)
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(
            payloads.some(({ url }) => url.endsWith('/api/v2/ci/tests/skippable')),
            false
          )
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_STATUS] === 'pass'))
          assert.strictEqual(coverages.length, 2, testOutput)
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'false')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 0)
        }, {
          requestFilter: ({ url }) =>
            url.endsWith('/api/v2/git/repository/packfile') ||
            url.endsWith('/api/v2/ci/tests/skippable') ||
            url.endsWith('/api/v2/citestcycle') ||
            url.endsWith('/api/v2/citestcov'),
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      const noIsolateConfigurations = [
        { name: 'NO_ISOLATE', env: { NO_ISOLATE: 'true' } },
        { name: 'POOL_NO_ISOLATE', env: { POOL_NO_ISOLATE: 'true' } },
        {
          name: 'THREADS_POOL_NO_ISOLATE',
          env: {
            POOL_CONFIG: 'threads',
            POOL_NO_ISOLATE: 'true',
          },
        },
        {
          name: 'PROJECT_NO_ISOLATE',
          env: {
            PROJECT_NO_ISOLATE: 'true',
            PROJECT_POOL_CONFIG: 'forks',
          },
        },
        {
          name: 'PROJECT_POOL_NO_ISOLATE',
          env: {
            PROJECT_POOL_CONFIG: 'forks',
            PROJECT_POOL_NO_ISOLATE: 'true',
          },
        },
      ]
      for (const { name, env } of noIsolateConfigurations) {
        const noIsolateIt = name.startsWith('PROJECT_') ? newerVitestIt : it
        noIsolateIt(`skips suites with ${name}`, async () => {
          receiver.setSuitesToSkip([{
            type: 'suite',
            attributes: { suite: secondSuite },
          }])

          await runTiaTests((payloads) => {
            const { events, testSuiteEvents, coverages, coverageBySuite } = getTiaPayloads(payloads)
            const metadataEntries = payloads
              .filter(({ url }) => url === '/api/v2/citestcycle')
              .flatMap(({ payload }) => payload.metadata || [])
            const skippedSuite = testSuiteEvents
              .find(({ content }) => content.meta[TEST_SUITE] === secondSuite)
              .content
            const testSession = events.find(event => event.type === 'test_session_end').content

            assert.strictEqual(payloads.some(({ url }) => url === skippableUrl), true)
            assert.strictEqual(coverages.length, 1)
            assert.strictEqual(testSuiteEvents.length, 2, testOutput)
            assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
            assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
            assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
            assert.deepStrictEqual(
              coverageBySuite.get(firstSuite),
              [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
            )
            assert.strictEqual(coverageBySuite.has(secondSuite), false)
            assert.ok(metadataEntries.length > 0, testOutput)
            for (const metadata of metadataEntries) {
              assert.strictEqual(metadata.test?.[DD_CAPABILITIES_TEST_IMPACT_ANALYSIS], '1')
            }
            assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
            assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
            assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
            assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          }, {
            env,
            requestFilter: tiaRequestFilter,
          })

          assert.strictEqual(childProcess.exitCode, 0, testOutput)
        })
      }

      for (const { description, coverageProvider, env, expectCumulative, newerVitestOnly, poolOptions } of [
        {
          description: 'without a coverage dependency',
          env: { NO_ISOLATE: 'true' },
        },
        {
          description: 'with user V8 coverage',
          coverageProvider: 'v8',
          env: { NO_ISOLATE: 'true' },
        },
        {
          description: 'with user Istanbul coverage',
          coverageProvider: 'istanbul',
          env: { NO_ISOLATE: 'true' },
        },
        {
          description: 'with the threads pool',
          env: {
            NO_ISOLATE: 'true',
            POOL_CONFIG: 'threads',
          },
        },
        {
          description: 'with project isolation disabled',
          env: {
            PROJECT_NO_ISOLATE: 'true',
            PROJECT_POOL_CONFIG: 'forks',
          },
          expectCumulative: version === 'latest',
          newerVitestOnly: true,
        },
        {
          description: 'with forks pool isolation disabled',
          env: { POOL_NO_ISOLATE: 'true' },
          poolOptions: true,
        },
        {
          description: 'with threads pool isolation disabled',
          env: {
            POOL_CONFIG: 'threads',
            POOL_NO_ISOLATE: 'true',
          },
          poolOptions: true,
        },
        {
          description: 'with project pool isolation disabled',
          env: {
            PROJECT_POOL_CONFIG: 'forks',
            PROJECT_POOL_NO_ISOLATE: 'true',
          },
          expectCumulative: false,
          newerVitestOnly: true,
          poolOptions: true,
        },
      ]) {
        const cumulativeCoverageIt =
          (newerVitestOnly && version === '1.6.0') || (poolOptions && version === 'latest')
            ? it.skip
            : it
        cumulativeCoverageIt(`reports conservative coverage for cached modules ${description}`, async () => {
          const sharedFirstSuite = 'ci-visibility/vitest-tests/tia-shared-first.mjs'
          const sharedSecondSuite = 'ci-visibility/vitest-tests/tia-shared-second.mjs'
          const sharedSource = 'ci-visibility/vitest-tests/sum.mjs'

          await runTiaTests((payloads) => {
            const { coverageBySuite } = getTiaPayloads(payloads)
            const firstCoverage = coverageBySuite.get(sharedFirstSuite)
            const secondCoverage = coverageBySuite.get(sharedSecondSuite)

            assert.ok(firstCoverage, testOutput)
            assert.ok(secondCoverage, testOutput)
            assert.ok(firstCoverage.includes(sharedSource), testOutput)
            assert.ok(secondCoverage.includes(sharedSource), testOutput)
            if (expectCumulative !== false) {
              assert.ok(
                [firstCoverage, secondCoverage].some(coverage =>
                  coverage.includes(sharedFirstSuite) && coverage.includes(sharedSecondSuite)
                ),
                testOutput
              )
            }
          }, {
            command: './node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism',
            coverageProvider,
            env: {
              ...env,
              TEST_DIR: 'ci-visibility/vitest-tests/tia-shared-{first,second}.mjs',
            },
          })

          assert.strictEqual(childProcess.exitCode, 0, testOutput)
        })
      }

      it('resets per-suite coverage when suites reuse one worker', async () => {
        await runTiaTests((payloads) => {
          const { coverages, coverageBySuite } = getTiaPayloads(payloads)

          assert.strictEqual(coverages.length, 2, testOutput)
          assert.deepStrictEqual(
            coverageBySuite.get(firstSuite),
            [firstSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.deepStrictEqual(
            coverageBySuite.get(secondSuite),
            ['ci-visibility/vitest-tests/bad-sum.mjs', secondSuite].sort()
          )
        }, {
          command: './node_modules/.bin/vitest run --maxWorkers=1 --no-file-parallelism',
          env: {
            POOL_CONFIG: 'threads',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      newerVitestIt('skips duplicate suite paths independently across projects', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageDetails } = getTiaPayloads(payloads)
          const firstSuites = testSuiteEvents.filter(({ content }) => content.meta[TEST_SUITE] === firstSuite)
          const secondSuites = testSuiteEvents.filter(({ content }) => content.meta[TEST_SUITE] === secondSuite)
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.strictEqual(testSuiteEvents.length, 4, testOutput)
          assert.strictEqual(firstSuites.length, 2)
          assert.strictEqual(secondSuites.length, 2)
          assert.ok(secondSuites.every(({ content }) => content.meta[TEST_STATUS] === 'skip'))
          assert.ok(secondSuites.every(({ content }) => content.meta[TEST_SKIPPED_BY_ITR] === 'true'))
          assert.strictEqual(events.filter(event => event.type === 'test').length, 2)
          assert.strictEqual(coverageDetails.filter(({ suite }) => suite === firstSuite).length, 2)
          assert.strictEqual(coverageDetails.some(({ suite }) => suite === secondSuite), false)
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 2)
        }, {
          env: {
            PROJECT_POOL_CONFIG: 'forks',
            SECOND_PROJECT_POOL_CONFIG: 'threads',
            SECOND_PROJECT_TEST_DIR: 'ci-visibility/vitest-tests/tia-{first,second}.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('reports coverage for a failing suite and fails the session', async () => {
        const failingSuite = 'ci-visibility/vitest-tests/tia-failing.mjs'

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const failedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === failingSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')
          assert.deepStrictEqual(
            coverageBySuite.get(failingSuite),
            [failingSuite, 'ci-visibility/vitest-tests/sum.mjs'].sort()
          )
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testModule.meta[TEST_STATUS], 'fail')
        }, {
          env: {
            TEST_DIR: 'ci-visibility/vitest-tests/tia-{failing,second}.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 1, testOutput)
      })

      it('reports mixed skipped and failed suites with the correct counts and status', async () => {
        const failingSuite = 'ci-visibility/vitest-tests/tia-failing.mjs'
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const failedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === failingSuite).content
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
          assert.strictEqual(failedSuite.meta[TEST_STATUS], 'fail')
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(coverageBySuite.has(failingSuite), true)
          assert.strictEqual(coverageBySuite.has(secondSuite), false)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          assert.strictEqual(testModule.meta[TEST_STATUS], 'fail')
          assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, {
          env: {
            TEST_DIR: 'ci-visibility/vitest-tests/tia-{failing,second}.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 1, testOutput)
      })

      it('applies TIA when a custom sequencer is enabled', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.match(testOutput, new RegExp(CUSTOM_SEQUENCER_MARKER))
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, {
          env: {
            CUSTOM_SEQUENCER: '1',
            CUSTOM_SEQUENCER_MARKER,
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      newerVitestIt('applies TIA after a custom sequencer and sharding are enabled', async () => {
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: secondSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const skippedSuite = testSuiteEvents.find(({ content }) => content.meta[TEST_SUITE] === secondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.match(testOutput, new RegExp(CUSTOM_SEQUENCER_MARKER))
          assert.strictEqual(testSuiteEvents.length, 4, testOutput)
          assert.strictEqual(skippedSuite.meta[TEST_STATUS], 'skip')
          assert.strictEqual(skippedSuite.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, {
          command: './node_modules/.bin/vitest run --shard=1/2',
          env: {
            CUSTOM_SEQUENCER: '1',
            CUSTOM_SEQUENCER_MARKER,
            TEST_DIR:
              'ci-visibility/vitest-tests/tia-{first,second,unskippable-to-run,unskippable-to-skip}.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      legacyVitestIt('applies TIA to the suites selected by a shard', async () => {
        const suites = [
          firstSuite,
          secondSuite,
          'ci-visibility/vitest-tests/tia-unskippable-to-run.mjs',
          'ci-visibility/vitest-tests/tia-unskippable-to-skip.mjs',
        ]
        receiver.setSuitesToSkip(suites.map(suite => ({
          type: 'suite',
          attributes: { suite },
        })))

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content

          assert.ok(testSuiteEvents.length > 0, testOutput)
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_STATUS] === 'skip'))
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_SKIPPED_BY_ITR] === 'true'))
          assert.strictEqual(testSession.meta[TEST_STATUS], 'skip')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], testSuiteEvents.length)
        }, {
          command: './node_modules/.bin/vitest run --shard=1/2',
          env: {
            TEST_DIR:
              'ci-visibility/vitest-tests/tia-{first,second,unskippable-to-run,unskippable-to-skip}.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      newerVitestIt('keeps TIA skipping and coverage correct across programmatic reruns', async () => {
        const programmaticFirstSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-first.mjs'
        const programmaticSecondSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-second.mjs'
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: programmaticFirstSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverageBySuite } = getTiaPayloads(payloads)
          const firstSuiteEvent = testSuiteEvents
            .find(({ content }) => content.meta[TEST_SUITE] === programmaticFirstSuite).content
          const secondSuiteEvent = testSuiteEvents
            .find(({ content }) => content.meta[TEST_SUITE] === programmaticSecondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.strictEqual(firstSuiteEvent.meta[TEST_STATUS], 'skip')
          assert.strictEqual(firstSuiteEvent.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(secondSuiteEvent.meta[TEST_STATUS], 'pass')
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
          assert.strictEqual(coverageBySuite.has(programmaticFirstSuite), false)
          assert.deepStrictEqual(
            coverageBySuite.get(programmaticSecondSuite),
            [
              'ci-visibility/vitest-tests/bad-sum.mjs',
              programmaticSecondSuite,
            ].sort()
          )
          assert.strictEqual(testSession.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testSession.metrics[TEST_ITR_SKIPPING_COUNT], 1)
          assert.strictEqual(testModule.meta[TEST_ITR_TESTS_SKIPPED], 'true')
          assert.strictEqual(testModule.metrics[TEST_ITR_SKIPPING_COUNT], 1)
        }, {
          command: 'node run-programmatic-api-tia-rerun.mjs',
          currentWorkingDirectory: path.join(cwd, 'ci-visibility/vitest-tests-programmatic-api'),
          env: {
            TEST_DIR: './tia-programmatic-*.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      newerVitestIt('does not apply TIA during programmatic watch reruns', async () => {
        const programmaticFirstSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-first.mjs'
        const programmaticSecondSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-second.mjs'
        receiver.setSuitesToSkip([
          {
            type: 'suite',
            attributes: { suite: programmaticFirstSuite },
          },
          {
            type: 'suite',
            attributes: { suite: programmaticSecondSuite },
          },
        ])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents, coverages } = getTiaPayloads(payloads)
          const testSession = events.find(event => event.type === 'test_session_end').content
          const urls = payloads.map(({ url }) => url)

          assert.strictEqual(urls.includes(skippableUrl), false)
          assert.strictEqual(coverages.length, 0)
          assert.strictEqual(testSuiteEvents.length, 2, testOutput)
          assert.ok(testSuiteEvents.every(({ content }) => content.meta[TEST_STATUS] === 'pass'))
          assert.strictEqual(events.filter(event => event.type === 'test').length, 2)
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'false')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'false')
        }, {
          command: 'node run-programmatic-api-tia-watch.mjs',
          currentWorkingDirectory: path.join(cwd, 'ci-visibility/vitest-tests-programmatic-api'),
          env: {
            TEST_DIR: './tia-programmatic-*.mjs',
          },
          requestFilter: tiaRequestFilter,
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      newerVitestIt('keeps a passing session when a later programmatic rerun disables TIA', async () => {
        const programmaticFirstSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-first.mjs'
        const programmaticSecondSuite =
          'ci-visibility/vitest-tests-programmatic-api/tia-programmatic-second.mjs'
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: programmaticFirstSuite },
        }])

        await runTiaTests((payloads) => {
          const { events, testSuiteEvents } = getTiaPayloads(payloads)
          const firstSuiteEvent = testSuiteEvents
            .find(({ content }) => content.meta[TEST_SUITE] === programmaticFirstSuite).content
          const secondSuiteEvent = testSuiteEvents
            .find(({ content }) => content.meta[TEST_SUITE] === programmaticSecondSuite).content
          const testSession = events.find(event => event.type === 'test_session_end').content
          const testModule = events.find(event => event.type === 'test_module_end').content

          assert.strictEqual(firstSuiteEvent.meta[TEST_STATUS], 'skip')
          assert.strictEqual(firstSuiteEvent.meta[TEST_SKIPPED_BY_ITR], 'true')
          assert.strictEqual(secondSuiteEvent.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSession.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testModule.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSession.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testSession.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
          assert.strictEqual(testModule.meta[TEST_ITR_SKIPPING_ENABLED], 'true')
          assert.strictEqual(testModule.meta[TEST_CODE_COVERAGE_ENABLED], 'true')
        }, {
          command: 'node run-programmatic-api-tia-unsupported-rerun.mjs',
          currentWorkingDirectory: path.join(cwd, 'ci-visibility/vitest-tests-programmatic-api'),
          env: {
            TEST_DIR: './tia-programmatic-*.mjs',
          },
        })

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })

      it('forwards TIA coverage and unskippable telemetry from Vitest workers', async () => {
        const unskippableSuite = 'ci-visibility/vitest-tests/tia-unskippable-marked.mjs'
        receiver.setSuitesToSkip([{
          type: 'suite',
          attributes: { suite: unskippableSuite },
        }])

        childProcess = exec('./node_modules/.bin/vitest run', {
          cwd,
          env: {
            ...getCiVisEvpProxyConfig(receiver.port),
            DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
            NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
            TEST_DIR: unskippableSuite,
          },
        })
        childProcess.stdout?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })
        childProcess.stderr?.on('data', (chunk) => {
          testOutput += chunk.toString()
        })

        await receiver.gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/apmtelemetry'),
          (payloads) => {
            const metricNames = new Set(
              payloads.flatMap(({ payload }) => payload.payload.series).map(({ metric }) => metric)
            )

            assert.ok(metricNames.has(TELEMETRY_CODE_COVERAGE_STARTED))
            assert.ok(metricNames.has(TELEMETRY_CODE_COVERAGE_FINISHED))
            assert.ok(metricNames.has(TELEMETRY_CODE_COVERAGE_NUM_FILES))
            assert.ok(metricNames.has(TELEMETRY_ITR_UNSKIPPABLE))
            assert.ok(metricNames.has(TELEMETRY_ITR_FORCED_TO_RUN))
          },
          { hardTimeout: 60_000 }
        )

        assert.strictEqual(childProcess.exitCode, 0, testOutput)
      })
    })
  })
})
