'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const admissionModuleUrl = pathToFileURL(path.join(
  __dirname,
  '..',
  '..',
  '..',
  'ci',
  'vitest-efd-suite-admission.mjs'
)).href

describe('vitest main instrumentation', () => {
  it('keeps no-worker capabilities active and handles EFD admission boundaries', async () => {
    const hooks = []
    const libraryConfigurationRequests = []
    const libraryConfigurationCh = {}
    const knownTestsCh = {}
    const providedContexts = []
    let reserveEarlyFlakeDetectionSuite
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
        },
        deactivate () {},
        isSupportedVersion () {
          return true
        },
        shouldUse () {
          return false
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

    class Typechecker {
      async prepareResults () {
        return { files: [] }
      }
    }
    const typecheckerHook = hooks.find(({ target }) => target.versions[0] === '>=4.0.0').hook
    typecheckerHook({ Typechecker }, '4.1.10')

    const typechecker = new Typechecker()
    typechecker.ctx = ctx
    await typechecker.prepareResults()

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

    assert.deepStrictEqual(
      libraryConfigurationRequests.map(request => request.isVitestNoWorkerInitActive),
      [true, true, true, true]
    )
    const efdAdmissionContexts = providedContexts.filter(context => '_ddIsEfdSuiteAdmissionEnabled' in context)
    assert.ok(efdAdmissionContexts.some(context => context._ddIsEfdSuiteAdmissionEnabled === true))
    assert.strictEqual(efdAdmissionContexts[efdAdmissionContexts.length - 1]._ddIsEfdSuiteAdmissionEnabled, false)
  })

  it('disables EFD retries when the Browser Mode command rejects', async () => {
    const error = new Error('command failed')
    const originalBrowserRunner = globalThis.__vitest_browser_runner__
    const triggerCommand = sinon.stub().rejects(error)
    const consoleError = sinon.stub(globalThis.console, 'error')
    globalThis.__vitest_browser_runner__ = {
      commands: { triggerCommand },
    }

    try {
      const { requestEfdSuiteAdmission } = await import(admissionModuleUrl)
      const isAllowed = await requestEfdSuiteAdmission({
        browserCommand: 'admit',
        hasNewTest: true,
        requestCode: 104,
        responseCode: 105,
        testSuite: 'test.mjs',
      })

      assert.strictEqual(isAllowed, false)
      assert.strictEqual(triggerCommand.callCount, 1)
      assert.strictEqual(consoleError.callCount, 1)
      assert.strictEqual(consoleError.firstCall.args[1], error)
    } finally {
      consoleError.restore()
      if (originalBrowserRunner === undefined) {
        delete globalThis.__vitest_browser_runner__
      } else {
        globalThis.__vitest_browser_runner__ = originalBrowserRunner
      }
    }
  })
})
