'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

const CONFIG_PATH = 'employee/LIVE_DEBUGGING/probe-1/config'

describe('debugger agentless Remote Config', () => {
  let RemoteConfigFetcher
  let addBreakpoint
  let clock
  let fetcher
  let log
  let modifyBreakpoint
  let probePort
  let removeBreakpoint
  let status

  beforeEach(() => {
    clock = undefined
    addBreakpoint = sinon.stub().resolves()
    modifyBreakpoint = sinon.stub().resolves()
    removeBreakpoint = sinon.stub().resolves()
    probePort = {
      on: sinon.stub(),
      postMessage: sinon.stub(),
    }
    status = {
      ackError: sinon.stub(),
      ackInstalled: sinon.stub(),
      ackReceived: sinon.stub(),
    }
    log = {
      debug: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    }
    fetcher = {
      fetchChanges: sinon.stub(),
      setConfigState: sinon.stub(),
      setProductCapabilities: sinon.stub().returns([]),
    }
    RemoteConfigFetcher = sinon.stub().returns(fetcher)
  })

  afterEach(() => {
    clock?.restore()
  })

  it('polls, applies, modifies, and removes agentless probes', async () => {
    const originalProbe = createProbe(0)
    const modifiedProbe = createProbe(1)
    fetcher.fetchChanges.onFirstCall().resolves([
      createChange('add', JSON.stringify(originalProbe)),
      createChange('update', JSON.stringify(modifiedProbe)),
      createChange('remove'),
    ])
    fetcher.fetchChanges.onSecondCall().returns(new Promise(() => {}))

    loadRemoteConfig()
    await flushPromises()

    sinon.assert.calledOnceWithExactly(RemoteConfigFetcher, {
      clientId: 'client-id',
      runtimeId: 'runtime-id',
      service: 'service',
      env: 'test',
      appVersion: '1.0.0',
      tags: ['runtime-id:runtime-id'],
      processTags: ['entrypoint.type:script'],
      language: 'node',
      tracerVersion: '1.2.3',
      url: 'https://datadoghq.com',
      timeoutMs: 5000,
      apiKey: 'test-api-key',
      hostname: 'test-host',
    })
    sinon.assert.calledOnceWithExactly(
      fetcher.setProductCapabilities,
      ['LIVE_DEBUGGING'],
      [
        'APM_TRACING_ENABLE_DYNAMIC_INSTRUMENTATION',
        'APM_TRACING_ENABLE_LIVE_DEBUGGING',
      ]
    )
    sinon.assert.calledOnceWithExactly(addBreakpoint, originalProbe)
    sinon.assert.calledOnceWithExactly(modifyBreakpoint, modifiedProbe)
    sinon.assert.calledOnceWithExactly(removeBreakpoint, modifiedProbe)
    assert.deepStrictEqual(fetcher.setConfigState.args, [
      [CONFIG_PATH, 2],
      [CONFIG_PATH, 2],
      [CONFIG_PATH, 2],
    ])
    sinon.assert.notCalled(status.ackError)
  })

  it('reports probe application errors to Remote Config', async () => {
    const probe = createProbe(0)
    probe.type = 'METRIC_PROBE'
    fetcher.fetchChanges.onFirstCall().resolves([
      createChange('add', JSON.stringify(probe)),
    ])
    fetcher.fetchChanges.onSecondCall().returns(new Promise(() => {}))

    loadRemoteConfig()
    await flushPromises()

    sinon.assert.calledOnceWithExactly(
      fetcher.setConfigState,
      CONFIG_PATH,
      3,
      'Error: Unsupported probe type: METRIC_PROBE (id: probe-1, version: 0)'
    )
    sinon.assert.calledOnce(status.ackError)
    sinon.assert.notCalled(addBreakpoint)
  })

  it('retries failed fetches after the configured interval', async () => {
    clock = sinon.useFakeTimers()
    fetcher.fetchChanges.onFirstCall().rejects(new Error('network error'))
    fetcher.fetchChanges.onSecondCall().returns(new Promise(() => {}))

    loadRemoteConfig()
    await clock.tickAsync(0)

    sinon.assert.calledOnce(fetcher.fetchChanges)
    sinon.assert.calledOnceWithExactly(
      log.error,
      '[debugger:devtools_client] Error fetching agentless Remote Config',
      sinon.match({ message: 'network error' })
    )

    await clock.tickAsync(4999)
    sinon.assert.calledOnce(fetcher.fetchChanges)

    await clock.tickAsync(1)
    sinon.assert.calledTwice(fetcher.fetchChanges)
  })

  it('does not create an agentless fetcher outside agentless mode', () => {
    loadRemoteConfig(false)

    sinon.assert.notCalled(RemoteConfigFetcher)
  })

  /**
   * Loads the worker Remote Config module with its external boundaries stubbed.
   *
   * @param {boolean} [agentless] - Whether agentless mode is enabled
   * @returns {void}
   */
  function loadRemoteConfig (agentless = true) {
    proxyquire.noPreserveCache()('../../../src/debugger/devtools_client/remote_config', {
      'node:crypto': { randomUUID: () => 'client-id' },
      'node:worker_threads': { workerData: { probePort } },
      '@datadog/libdatadog': {
        RemoteConfigFetcher,
        '@noCallThru': true,
      },
      './breakpoints': {
        addBreakpoint,
        modifyBreakpoint,
        removeBreakpoint,
        '@noCallThru': true,
      },
      './config': {
        agentless,
        remoteConfig: {
          runtimeId: 'runtime-id',
          service: 'service',
          env: 'test',
          appVersion: '1.0.0',
          tags: ['runtime-id:runtime-id'],
          processTags: ['entrypoint.type:script'],
          language: 'node',
          tracerVersion: '1.2.3',
          url: 'https://datadoghq.com',
          timeoutMs: 5000,
          retryIntervalMs: 5000,
          apiKey: 'test-api-key',
          hostname: 'test-host',
        },
        '@noCallThru': true,
      },
      './log': {
        ...log,
        '@noCallThru': true,
      },
      './status': {
        ...status,
        '@noCallThru': true,
      },
    })
  }
})

/**
 * Creates a debugger probe fixture.
 *
 * @param {number} version - Probe version
 * @returns {object} Probe fixture
 */
function createProbe (version) {
  return {
    id: 'probe-1',
    version,
    type: 'LOG_PROBE',
    where: {
      sourceFile: 'app.js',
      lines: ['10'],
    },
  }
}

/**
 * Creates an agentless Remote Config change fixture.
 *
 * @param {'add' | 'update' | 'remove'} kind - Change kind
 * @param {string} [contents] - Serialized probe
 * @returns {object} Remote Config change
 */
function createChange (kind, contents) {
  return {
    kind,
    path: CONFIG_PATH,
    product: 'LIVE_DEBUGGING',
    configId: 'probe-1',
    name: 'config',
    version: 1,
    contents,
  }
}

/**
 * Flushes pending promise callbacks.
 *
 * @returns {Promise<void>}
 */
function flushPromises () {
  return new Promise(resolve => setImmediate(resolve))
}
