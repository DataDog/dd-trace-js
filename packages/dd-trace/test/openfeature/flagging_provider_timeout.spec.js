'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { DatadogNodeServerProvider } = require('@datadog/openfeature-node-server')
const { ProviderEvents } = require('@openfeature/server-sdk')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/mocha')

describe('FlaggingProvider Initialization Timeout', () => {
  let FlaggingProvider
  let mockTracer
  let mockConfig
  let mockChannel
  let log
  let channelStub
  let clock

  beforeEach(() => {
    // Use fake timers to control setTimeout
    clock = sinon.useFakeTimers()

    mockTracer = {
      _config: { service: 'test-service' },
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      featureFlags: {
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: true,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 30_000, // Default timeout
      },
    }

    mockChannel = {
      publish: sinon.spy(),
      hasSubscribers: false,
    }

    channelStub = sinon.stub().returns(mockChannel)

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      errorWithoutTelemetry: sinon.spy(),
      warn: sinon.spy(),
    }

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
      './configuration_source': {
        create: sinon.stub(),
      },
      './writers/flag-eval-evp-hook': sinon.stub().returns({ destroy: sinon.spy() }),
      '../../../../vendor/dist/@datadog/openfeature-node-server': { DatadogNodeServerProvider },
    })
  })

  afterEach(() => {
    // Restore real timers
    clock.restore()
  })

  it('should timeout after 30 seconds when configuration is not set', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Start initialization (returns a promise)
    const initPromise = provider.initialize()

    // Attach catch handler BEFORE ticking clock to prevent unhandled rejection
    initPromise.catch(() => {
      // Expected to reject on timeout
    })

    // Verify initialization is in progress
    assert.ok(provider.initController)
    assert.strictEqual(provider.initController.isInitializing(), true)

    // Advance time by 30 seconds (default timeout) and run pending promises
    await clock.tickAsync(30000)

    // Wait for promise to settle
    await initPromise.catch(() => {})

    // Verify initialization is no longer in progress
    assert.strictEqual(provider.initController.isInitializing(), false)
  })

  it('does not keep the process alive while waiting for configuration', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    const initPromise = provider.initialize()

    initPromise.catch(() => {
      // Expected to reject on timeout
    })

    assert.strictEqual(provider.initController.timeoutId.hasRef(), false)

    await clock.tickAsync(30000)
    await initPromise.catch(() => {})
  })

  it('returns the upstream initialization promise without adding a settlement handler', async () => {
    const promise = Promise.resolve()
    const then = sinon.spy(promise, 'then')
    const initialize = sinon.stub(DatadogNodeServerProvider.prototype, 'initialize').returns(promise)
    try {
      const provider = new FlaggingProvider(mockTracer, mockConfig)

      assert.strictEqual(provider.initialize(), promise)
      sinon.assert.notCalled(then)
      await promise
    } finally {
      initialize.restore()
    }
  })

  it('logs configuration that arrived before initialization', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const configuration = { flags: {} }
    provider.setConfiguration(configuration)
    log.debug.resetHistory()

    await provider.initialize()

    assert.strictEqual(provider.getConfiguration(), configuration)
    sinon.assert.calledWith(log.debug, 'Feature Flags: initial configuration available')
    assert.strictEqual(provider.initController, undefined)
  })

  it('does not log initialization outcomes for later configuration changes or errors', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const promise = provider.initialize()
    provider.setConfiguration({ flags: {} })
    await promise
    log.debug.resetHistory()

    provider.setConfiguration({ flags: { updated: {} } })
    provider.setError(new Error('later failure'))

    sinon.assert.notCalled(log.debug)
    sinon.assert.notCalled(log.errorWithoutTelemetry)
  })

  it('does not log errors before initialization starts', () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    provider.setError(new Error('before initialization'))

    sinon.assert.notCalled(log.errorWithoutTelemetry)
  })

  for (const configuration of [undefined, null]) {
    it(`keeps waiting after a ${configuration} update and logs the first available configuration`, async () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const initialized = sinon.spy()
      const promise = provider.initialize().then(initialized)
      log.debug.resetHistory()

      provider.setConfiguration(configuration)
      await clock.tickAsync(29999)

      assert.strictEqual(provider.getConfiguration(), undefined)
      sinon.assert.notCalled(initialized)
      sinon.assert.notCalled(log.debug)
      sinon.assert.notCalled(log.errorWithoutTelemetry)

      provider.setConfiguration({ flags: {} })
      await promise

      sinon.assert.calledOnce(initialized)
      sinon.assert.calledOnceWithExactly(log.debug, 'Feature Flags: initial configuration available')
      await clock.tickAsync(1)
      sinon.assert.notCalled(log.errorWithoutTelemetry)

      log.debug.resetHistory()
      provider.setConfiguration({ flags: {} })
      sinon.assert.notCalled(log.debug)
    })

    it(`preserves the initialization timeout and diagnostic after repeated ${configuration} updates`, async () => {
      const provider = new FlaggingProvider(mockTracer, mockConfig)
      const rejection = assert.rejects(provider.initialize(), {
        name: 'Error', message: 'Initialization timeout after 30000ms',
      })
      log.debug.resetHistory()

      provider.setConfiguration(configuration)
      await clock.tickAsync(10000)
      provider.setConfiguration(configuration)
      await clock.tickAsync(19999)
      sinon.assert.notCalled(log.errorWithoutTelemetry)

      await clock.tickAsync(1)
      await rejection
      sinon.assert.calledOnceWithExactly(
        log.errorWithoutTelemetry,
        'Feature Flags: provider failed to initialize: %s',
        'Initialization timeout after 30000ms'
      )

      log.debug.resetHistory()
      provider.setConfiguration({ flags: {} })
      // Configuration arriving after the timeout takes the recovery branch, not the initial one.
      sinon.assert.calledOnce(log.debug)
    })
  }

  it('does not log the initialization timeout when configuration is already applied', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    provider.setConfiguration({ flags: {} })
    log.debug.resetHistory()

    await provider.initialize()

    sinon.assert.neverCalledWith(log.debug, sinon.match.string, 30_000)
  })

  it('logs only the first configuration before the initialization promise settles', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const promise = provider.initialize()
    log.debug.resetHistory()

    provider.setConfiguration({ flags: {} })
    provider.setConfiguration({ flags: {} })
    await promise

    sinon.assert.calledOnceWithExactly(log.debug, 'Feature Flags: initial configuration available')
  })

  it('logs a new initialization attempt after an error', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const promise = provider.initialize()
    const error = new Error('first initialization failed')
    const rejection = assert.rejects(promise, error)
    provider.setError(error)
    await rejection

    const retry = provider.initialize()
    log.debug.resetHistory()
    provider.setConfiguration({ flags: {} })
    await retry

    sinon.assert.calledOnceWithExactly(log.debug, 'Feature Flags: initial configuration available')
    sinon.assert.calledOnce(log.errorWithoutTelemetry)
  })

  it('preserves successful initialization if configuration logging throws', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const promise = provider.initialize()
    log.debug = sinon.stub().throws(new Error('logging failed'))
    const configuration = { flags: {} }

    provider.setConfiguration(configuration)
    await promise

    assert.strictEqual(provider.getConfiguration(), configuration)
    sinon.assert.calledOnce(log.debug)
  })

  it('preserves the initialization rejection if error logging throws', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)
    const promise = provider.initialize()
    const error = new Error('initialization failed')
    const rejection = assert.rejects(promise, error)
    log.errorWithoutTelemetry = sinon.stub().throws(new Error('logging failed'))

    provider.setError(error)

    await rejection
    sinon.assert.calledOnce(log.errorWithoutTelemetry)
  })

  it('should not timeout if configuration is set before 30 seconds', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Start initialization
    log.debug.resetHistory()
    const initPromise = provider.initialize()

    // Verify initialization is in progress
    assert.strictEqual(provider.initController.isInitializing(), true)
    sinon.assert.calledWith(log.debug, sinon.match.string, 30_000)

    // Advance time by 20 seconds (before timeout)
    await clock.tickAsync(20000)

    // Set configuration before timeout
    const ufc = {
      flags: {
        'test-flag': {
          key: 'test-flag',
          variations: [
            { key: 'on', value: true },
            { key: 'off', value: false },
          ],
        },
      },
    }
    provider.setConfiguration(ufc)

    // Wait for initialization to complete
    await initPromise

    // Verify initialization completed successfully
    assert.strictEqual(provider.initController.isInitializing(), false)
    assert.strictEqual(provider.getConfiguration(), ufc)
    sinon.assert.calledWith(log.debug, 'Feature Flags: initial configuration available')
  })

  it('should call setError with timeout message after 30 seconds', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Spy on setError method
    const setErrorSpy = sinon.spy(provider, 'setError')

    const initPromise = provider.initialize()

    // Attach catch handler BEFORE ticking clock to prevent unhandled rejection
    initPromise.catch(() => {
      // Expected to reject
    })

    // Advance time to trigger timeout
    await clock.tickAsync(30000)

    await initPromise.catch(() => {})

    // Verify setError was called with timeout error
    sinon.assert.calledOnce(setErrorSpy)
    const errorArg = setErrorSpy.firstCall.args[0]
    assert.ok(errorArg instanceof Error)
    assert.strictEqual(errorArg.message, 'Initialization timeout after 30000ms')

    sinon.assert.calledOnceWithExactly(
      log.errorWithoutTelemetry,
      'Feature Flags: provider failed to initialize: %s',
      'Initialization timeout after 30000ms'
    )
  })

  it('logs a non-Error rejection reason without throwing', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    const initPromise = provider.initialize()
    initPromise.catch(() => {})

    // setError() is a public provider method; its argument is not guaranteed to be an Error.
    provider.setError('plain string failure')

    await initPromise.catch(() => {})

    sinon.assert.calledOnceWithExactly(
      log.errorWithoutTelemetry,
      'Feature Flags: provider failed to initialize: %s',
      'plain string failure'
    )
  })

  it('should allow recovery if configuration is set after timeout', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Spy on event emitter
    const readyEventSpy = sinon.spy()
    provider.events.addHandler(ProviderEvents.Ready, readyEventSpy)

    const initPromise = provider.initialize()

    // Attach catch handler BEFORE ticking clock to prevent unhandled rejection
    initPromise.catch(() => {
      // Expected to reject
    })

    // Trigger timeout
    await clock.tickAsync(30000)

    // Wait for initialization to complete/fail
    await initPromise.catch(() => {})

    // Configuration is still not set
    assert.strictEqual(provider.getConfiguration(), undefined)
    log.debug.resetHistory()

    // Now set configuration after timeout
    const ufc = { flags: { 'recovery-flag': {} } }
    provider.setConfiguration(ufc)

    // Should emit READY event to signal recovery
    sinon.assert.calledOnce(readyEventSpy)
    assert.strictEqual(provider.getConfiguration(), ufc)
    sinon.assert.calledOnce(log.errorWithoutTelemetry)
    sinon.assert.calledOnce(log.debug)

    // A removed and restored configuration is the same recovery transition.
    provider.setConfiguration(undefined)
    provider.setConfiguration(ufc)

    sinon.assert.calledTwice(readyEventSpy)
    sinon.assert.calledOnce(log.errorWithoutTelemetry)
    sinon.assert.calledTwice(log.debug)
  })

  describe('custom timeout configuration', () => {
    it('should use custom timeout when specified in config', async () => {
      const customConfig = {
        ...mockConfig,
        featureFlags: {
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: true,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 5000, // Custom 5-second timeout
        },
      }

      const provider = new FlaggingProvider(mockTracer, customConfig)

      const initPromise = provider.initialize()

      // Attach catch handler
      initPromise.catch(() => {
        // Expected to reject on timeout
      })

      // Verify initialization is in progress
      assert.strictEqual(provider.initController.isInitializing(), true)

      // Advance time by 4.9 seconds (before custom timeout)
      await clock.tickAsync(4900)

      // Should still be initializing
      assert.strictEqual(provider.initController.isInitializing(), true)

      // Advance by another 200ms to trigger the 5-second timeout
      await clock.tickAsync(200)

      // Wait for promise to settle
      await initPromise.catch(() => {})

      // Should now be timed out
      assert.strictEqual(provider.initController.isInitializing(), false)
    })

    it('should call setError with custom timeout value in message', async () => {
      const customConfig = {
        ...mockConfig,
        featureFlags: {
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: true,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 10_000, // Custom 10-second timeout
        },
      }

      const provider = new FlaggingProvider(mockTracer, customConfig)

      // Spy on setError method
      const setErrorSpy = sinon.spy(provider, 'setError')

      const initPromise = provider.initialize()

      // Attach catch handler
      initPromise.catch(() => {
        // Expected to reject
      })

      // Advance time to trigger custom timeout
      await clock.tickAsync(10000)

      await initPromise.catch(() => {})

      // Verify setError was called with custom timeout error
      sinon.assert.calledOnce(setErrorSpy)
      const errorArg = setErrorSpy.firstCall.args[0]
      assert.ok(errorArg instanceof Error)
      assert.strictEqual(errorArg.message, 'Initialization timeout after 10000ms')
    })
  })

  describe('environment variable timeout configuration', () => {
    let originalEnv

    beforeEach(() => {
      // Save original environment variable
      originalEnv = {
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS:
          process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS,
      }
    })

    afterEach(() => {
      // Restore original environment variable
      if (originalEnv.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS !== undefined) {
        process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS =
          originalEnv.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS
      } else {
        delete process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS
      }
    })

    it('should use DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS environment variable', async () => {
      // Set environment variable for 6-second timeout
      process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS = '6000'

      // Need to reload the config module to pick up env var
      delete require.cache[require.resolve('../../src/config')]
      const Config = require('../../src/config')
      const config = new Config({})

      const provider = new FlaggingProvider(mockTracer, config)

      // Spy on setError method to verify timeout message
      const setErrorSpy = sinon.spy(provider, 'setError')

      const initPromise = provider.initialize()

      // Attach catch handler
      initPromise.catch(() => {
        // Expected to reject
      })

      // Advance time to trigger env var timeout
      await clock.tickAsync(6000)

      await initPromise.catch(() => {})

      // Verify setError was called with env var timeout error
      assert.strictEqual(setErrorSpy.calledOnce, true)
      const errorArg = setErrorSpy.firstCall.args[0]
      assert.ok(errorArg instanceof Error)
      assert.ok(errorArg.message.includes('Initialization timeout'), `Got: ${inspect(errorArg.message)}`)
      assert.ok(errorArg.message.includes('6000ms'), `Got: ${inspect(errorArg.message)}`)
    })

    it('should use config object value over environment variables', async () => {
      // Set environment variable
      process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS = '7000'

      // Config with explicit timeout (should override env var)
      const configWithTimeout = {
        ...mockConfig,
        featureFlags: {
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_ENABLED: true,
          DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 3000, // This should override env var
        },
      }

      const provider = new FlaggingProvider(mockTracer, configWithTimeout)

      const initPromise = provider.initialize()

      // Attach catch handler
      initPromise.catch(() => {
        // Expected to reject on timeout
      })

      // Verify initialization is in progress
      assert.strictEqual(provider.initController.isInitializing(), true)

      // Advance time by 2.9 seconds (before config timeout)
      await clock.tickAsync(2900)

      // Should still be initializing
      assert.strictEqual(provider.initController.isInitializing(), true)

      // Advance by another 200ms to trigger the 3-second timeout (config takes priority)
      await clock.tickAsync(200)

      // Wait for promise to settle
      await initPromise.catch(() => {})

      // Should now be timed out (using config value, not env var)
      assert.strictEqual(provider.initController.isInitializing(), false)
    })
  })
})
