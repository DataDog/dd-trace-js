'use strict'

const assert = require('node:assert/strict')

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
      experimental: {
        flaggingProvider: {
          enabled: true,
          initializationTimeoutMs: 30_000, // Default timeout
        },
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
      warn: sinon.spy(),
    }

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub,
      },
      '../log': log,
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

  it('should not timeout if configuration is set before 30 seconds', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Start initialization
    const initPromise = provider.initialize()

    // Verify initialization is in progress
    assert.strictEqual(provider.initController.isInitializing(), true)

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
    provider._setConfiguration(ufc)

    // Wait for initialization to complete
    await initPromise

    // Verify initialization completed successfully
    assert.strictEqual(provider.initController.isInitializing(), false)
    assert.strictEqual(provider.getConfiguration(), ufc)
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

    // Now set configuration after timeout
    const ufc = { flags: { 'recovery-flag': {} } }
    provider._setConfiguration(ufc)

    // Should emit READY event to signal recovery
    sinon.assert.calledOnce(readyEventSpy)
    assert.strictEqual(provider.getConfiguration(), ufc)
  })

  describe('custom timeout configuration', () => {
    it('should use custom timeout when specified in config', async () => {
      const customConfig = {
        ...mockConfig,
        experimental: {
          flaggingProvider: {
            enabled: true,
            initializationTimeoutMs: 5000, // Custom 5-second timeout
          },
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
        experimental: {
          flaggingProvider: {
            enabled: true,
            initializationTimeoutMs: 10_000, // Custom 10-second timeout
          },
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
      assert.ok(errorArg.message.includes('Initialization timeout'))
      assert.ok(errorArg.message.includes('6000ms'))
    })

    it('should use config object value over environment variables', async () => {
      // Set environment variable
      process.env.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS = '7000'

      // Config with explicit timeout (should override env var)
      const configWithTimeout = {
        ...mockConfig,
        experimental: {
          flaggingProvider: {
            enabled: true,
            initializationTimeoutMs: 3000, // This should override env var
          },
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
