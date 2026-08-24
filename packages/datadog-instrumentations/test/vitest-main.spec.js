'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire').noPreserveCache()

const {
  getProvidedContext,
  parseProvidedContextValue,
  setProvidedContext,
} = require('../src/vitest-util')

describe('vitest utilities', () => {
  describe('browser-safe provided context', () => {
    it('leaves safe values unchanged', () => {
      const context = { knownTests: ['safe test'] }
      const providedContext = {}
      const ctx = {
        getRootProject () {
          return { _provided: providedContext }
        },
      }

      setProvidedContext(ctx, {
        _ddUndefined: undefined,
        _ddNull: null,
        _ddBoolean: false,
        _ddNumber: 42,
        _ddString: 'safe test',
        _ddContext: context,
      }, 'Could not set provided context.')

      assert.strictEqual(providedContext._ddUndefined, undefined)
      assert.strictEqual(providedContext._ddNull, null)
      assert.strictEqual(providedContext._ddBoolean, false)
      assert.strictEqual(providedContext._ddNumber, 42)
      assert.strictEqual(providedContext._ddString, 'safe test')
      assert.strictEqual(providedContext._ddContext, context)
      assert.strictEqual(parseProvidedContextValue('safe test'), 'safe test')
      assert.strictEqual(parseProvidedContextValue(context), context)
    })

    it('rejects malformed serialized context', () => {
      const providedContext = {}
      const ctx = {
        getRootProject () {
          return { _provided: providedContext }
        },
      }

      setProvidedContext(ctx, {
        _ddTestPropertiesByFilepath: { knownTests: ['test containing </script>'] },
      }, 'Could not set provided context.')

      assert.strictEqual(parseProvidedContextValue(providedContext._ddTestPropertiesByFilepath.slice(0, -1)), undefined)
    })

    it('escapes every Datadog-provided value without changing user context', () => {
      const providedContext = {}
      const userContext = { testName: '</script>' }
      const testCommand = 'vitest --testNamePattern=</script>'
      const ctx = {
        getRootProject () {
          return { _provided: providedContext }
        },
      }

      setProvidedContext(ctx, {
        _ddIsKnownTestsEnabled: true,
        _ddTestCommand: testCommand,
        userContext,
      }, 'Could not set provided context.')

      assert.strictEqual(providedContext._ddIsKnownTestsEnabled, true)
      assert.ok(!providedContext._ddTestCommand.includes('<'))
      assert.strictEqual(parseProvidedContextValue(providedContext._ddTestCommand), testCommand)
      assert.strictEqual(providedContext.userContext, userContext)
    })

    it('restores every Datadog-provided value for workers', () => {
      const providedContext = {}
      const testCommand = 'vitest --testNamePattern=</script>'
      const testPropertiesByFilepath = {
        'test.mjs': { knownTests: ['test containing </ScRiPt> and <markup>'] },
      }
      const ctx = {
        getRootProject () {
          return { _provided: providedContext }
        },
      }
      const previousWorker = globalThis.__vitest_worker__

      setProvidedContext(ctx, {
        _ddTestCommand: testCommand,
        _ddTestPropertiesByFilepath: testPropertiesByFilepath,
      }, 'Could not set provided context.')
      globalThis.__vitest_worker__ = { providedContext }

      try {
        assert.ok(!providedContext._ddTestCommand.includes('<'))
        assert.ok(!providedContext._ddTestPropertiesByFilepath.includes('<'))

        const restoredContext = getProvidedContext()

        assert.strictEqual(restoredContext.testCommand, testCommand)
        assert.deepStrictEqual(restoredContext.testPropertiesByFilepath, testPropertiesByFilepath)
      } finally {
        if (previousWorker === undefined) {
          delete globalThis.__vitest_worker__
        } else {
          globalThis.__vitest_worker__ = previousWorker
        }
      }
    })
  })
})

describe('vitest main instrumentation', () => {
  it('keeps no-worker capabilities active and handles EFD admission boundaries', async () => {
    const hooks = []
    const libraryConfigurationRequests = []
    const libraryConfigurationCh = {}
    const knownTestsCh = {}
    const noWorkerInitStates = []
    const providedContexts = []
    const testSuiteFinishPayloads = []
    let reserveEarlyFlakeDetectionSuite
    let shouldUseNoWorkerInit = false
    const testSuiteFinishCh = {
      hasSubscribers: true,
    }
    const testSessionFinishCh = {
      hasSubscribers: true,
    }
    const testSessionConfigurationCh = {
      hasSubscribers: false,
    }
    const channel = {
      hasSubscribers: false,
      publish () {},
      runStores (store, callback) {
        store.currentStore = {}
        callback()
      },
    }
    const realInstrument = require('../src/helpers/instrument')
    const realVitestUtil = require('../src/vitest-util')

    proxyquire('../src/vitest-main', {
      './helpers/channel': {
        getChannelPromise (currentChannel, data) {
          if (currentChannel === libraryConfigurationCh) {
            libraryConfigurationRequests.push(data)
            return Promise.resolve({
              libraryConfig: {
                earlyFlakeDetectionFaultyThreshold: 1,
                earlyFlakeDetectionRetryPolicy: {
                  durationRetryCounts: [
                    { durationLimitMs: 5000, retryCount: 2 },
                  ],
                  schedulingRetryCount: 2,
                },
                isEarlyFlakeDetectionEnabled: true,
                isKnownTestsEnabled: true,
              },
            })
          }
          if (currentChannel === knownTestsCh) {
            return Promise.resolve({ knownTests: { vitest: {} } })
          }
          if (currentChannel === testSuiteFinishCh) {
            testSuiteFinishPayloads.push(data)
          }
          return Promise.resolve()
        },
      },
      './helpers/instrument': {
        ...realInstrument,
        addHook (target, hook) {
          hooks.push({ hook, target })
        },
      },
      './vitest-main-no-worker-init': {
        configure (_ctx, _frameworkVersion, _testSpecifications, _setupData, options) {
          reserveEarlyFlakeDetectionSuite = options.reserveEarlyFlakeDetectionSuite
          noWorkerInitStates.push(options.state)
        },
        deactivate () {},
        isSupportedVersion () {
          return true
        },
        shouldUse () {
          return shouldUseNoWorkerInit
        },
      },
      './vitest-util': {
        ...realVitestUtil,
        codeCoverageReportCh: channel,
        findExportByName (vitestPackage, exportName) {
          for (const [key, value] of Object.entries(vitestPackage)) {
            if (value?.name === exportName) return { key, value }
          }
        },
        getWorkspaceProject () {
          return {
            getProvidedContext () {
              return {}
            },
          }
        },
        isEarlyFlakeDetectionFaultyCh: channel,
        knownTestsCh,
        libraryConfigurationCh,
        modifiedFilesCh: channel,
        setProvidedContext (_ctx, providedContext) {
          providedContexts.push(providedContext)
        },
        testManagementTestsCh: channel,
        testSessionConfigurationCh,
        testSessionFinishCh,
        testSuiteFinishCh,
      },
    })

    class BaseSequencer {
      async sort (specifications) {
        return specifications
      }
    }
    const sequencerHook = hooks.find(({ target }) => target.filePattern === 'dist/chunks/coverage.*').hook
    sequencerHook({ BaseSequencer }, '4.1.10')

    const ctx = {
      close () {},
      config: {},
      exit () {},
      getTestFilepaths () {
        return []
      },
    }
    const sequencer = new BaseSequencer()
    sequencer.ctx = ctx
    await sequencer.sort([{ filepath: '/repo/browser.mjs', pool: 'browser' }])

    assert.strictEqual(reserveEarlyFlakeDetectionSuite('/repo/shared.mjs', false), true)
    assert.strictEqual(reserveEarlyFlakeDetectionSuite('/repo/shared.mjs', true), true)
    assert.strictEqual(reserveEarlyFlakeDetectionSuite('/repo/second.mjs', true), false)
    assert.strictEqual(reserveEarlyFlakeDetectionSuite('/repo/shared.mjs', false), false)

    class Typechecker {
      async prepareResults () {
        return {
          files: [{ filepath: '/repo/typecheck.ts', result: { state: 'pass' }, tasks: [] }],
        }
      }
    }
    const typecheckerHook = hooks.find(({ target }) => target.versions[0] === '>=4.0.0').hook
    typecheckerHook({ Typechecker }, '4.1.10')

    const typechecker = new Typechecker()
    typechecker.ctx = ctx
    await typechecker.prepareResults()
    assert.strictEqual(testSuiteFinishPayloads.length, 1)
    assert.strictEqual(testSuiteFinishPayloads[0].deferFlush, true)

    const customPoolTypechecker = new Typechecker()
    customPoolTypechecker.ctx = {
      ...ctx,
      config: { pool: './custom-pool.mjs' },
    }
    await customPoolTypechecker.prepareResults()
    const customPoolAdmissionContexts = providedContexts.filter(context => '_ddIsEfdSuiteAdmissionEnabled' in context)
    assert.strictEqual(
      customPoolAdmissionContexts[customPoolAdmissionContexts.length - 1]._ddIsEfdSuiteAdmissionEnabled,
      false
    )

    await sequencer.sort([[
      { config: { pool: 'forks' } },
      { filepath: '/repo/vm.mjs', pool: 'vmThreads' },
    ]])
    const vmAdmissionContexts = providedContexts.filter(context => '_ddIsEfdSuiteAdmissionEnabled' in context)
    assert.strictEqual(vmAdmissionContexts[vmAdmissionContexts.length - 1]._ddIsEfdSuiteAdmissionEnabled, false)

    await sequencer.sort([[
      { config: { pool: 'forks' } },
      { filepath: '/repo/typecheck.ts', pool: 'typescript' },
    ]])

    await sequencer.sort([[
      { config: { pool: 'forks' } },
      { filepath: '/repo/custom.mjs', pool: './custom-pool.mjs' },
    ]])

    shouldUseNoWorkerInit = true
    await sequencer.sort([[
      { config: { pool: 'forks' } },
      { filepath: '/repo/no-worker.mjs', pool: 'threads' },
    ]])
    assert.strictEqual(noWorkerInitStates[noWorkerInitStates.length - 1].isEfdSuiteAdmissionEnabled, false)

    assert.deepStrictEqual(
      libraryConfigurationRequests.map(request => request.isVitestNoWorkerInitActive),
      [true, true, true, true, true, true, true]
    )
    const efdAdmissionContexts = providedContexts.filter(context => '_ddIsEfdSuiteAdmissionEnabled' in context)
    assert.ok(efdAdmissionContexts.some(context => context._ddIsEfdSuiteAdmissionEnabled === true))
    assert.strictEqual(efdAdmissionContexts[efdAdmissionContexts.length - 1]._ddIsEfdSuiteAdmissionEnabled, false)
  })
})
