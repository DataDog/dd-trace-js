'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const { ProviderEvents } = require('@openfeature/server-sdk')

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
      _config: { service: 'test-service' }
    }

    mockConfig = {
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
      experimental: {
        flaggingProvider: {
          enabled: true,
          timeoutMs: 30000 // Default timeout
        }
      }
    }

    mockChannel = {
      publish: sinon.spy(),
      hasSubscribers: false
    }

    channelStub = sinon.stub().returns(mockChannel)

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy()
    }

    FlaggingProvider = proxyquire('../../src/openfeature/flagging_provider', {
      'dc-polyfill': {
        channel: channelStub
      },
      '../log': log
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
    expect(provider.initController).to.exist
    expect(provider.initController.isInitializing()).to.be.true

    // Advance time by 30 seconds (default timeout) and run pending promises
    await clock.tickAsync(30000)

    // Wait for promise to settle
    await initPromise.catch(() => {})

    // Verify initialization is no longer in progress
    expect(provider.initController.isInitializing()).to.be.false
  })

  it('should not timeout if configuration is set before 30 seconds', async () => {
    const provider = new FlaggingProvider(mockTracer, mockConfig)

    // Start initialization
    const initPromise = provider.initialize()

    // Verify initialization is in progress
    expect(provider.initController.isInitializing()).to.be.true

    // Advance time by 20 seconds (before timeout)
    await clock.tickAsync(20000)

    // Set configuration before timeout
    const ufc = {
      flags: {
        'test-flag': {
          key: 'test-flag',
          variations: [
            { key: 'on', value: true },
            { key: 'off', value: false }
          ]
        }
      }
    }
    provider._setConfiguration(ufc)

    // Wait for initialization to complete
    await initPromise

    // Verify initialization completed successfully
    expect(provider.initController.isInitializing()).to.be.false
    expect(provider.getConfiguration()).to.equal(ufc)
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
    expect(setErrorSpy).to.have.been.calledOnce
    const errorArg = setErrorSpy.firstCall.args[0]
    expect(errorArg).to.be.instanceOf(Error)
    expect(errorArg.message).to.include('Initialization timeout')
    expect(errorArg.message).to.include('30000ms')
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
    expect(provider.getConfiguration()).to.be.undefined

    // Now set configuration after timeout
    const ufc = { flags: { 'recovery-flag': {} } }
    provider._setConfiguration(ufc)

    // Should emit READY event to signal recovery
    expect(readyEventSpy).to.have.been.calledOnce
    expect(provider.getConfiguration()).to.equal(ufc)
  })

  describe('custom timeout configuration', () => {
    it('should use custom timeout when specified in config', async () => {
      const customConfig = {
        ...mockConfig,
        experimental: {
          flaggingProvider: {
            enabled: true,
            timeoutMs: 5000 // Custom 5-second timeout
          }
        }
      }

      const provider = new FlaggingProvider(mockTracer, customConfig)

      const initPromise = provider.initialize()

      // Attach catch handler
      initPromise.catch(() => {
        // Expected to reject on timeout
      })

      // Verify initialization is in progress
      expect(provider.initController.isInitializing()).to.be.true

      // Advance time by 4.9 seconds (before custom timeout)
      await clock.tickAsync(4900)

      // Should still be initializing
      expect(provider.initController.isInitializing()).to.be.true

      // Advance by another 200ms to trigger the 5-second timeout
      await clock.tickAsync(200)

      // Wait for promise to settle
      await initPromise.catch(() => {})

      // Should now be timed out
      expect(provider.initController.isInitializing()).to.be.false
    })

    it('should call setError with custom timeout value in message', async () => {
      const customConfig = {
        ...mockConfig,
        experimental: {
          flaggingProvider: {
            enabled: true,
            timeoutMs: 10000 // Custom 10-second timeout
          }
        }
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
      expect(setErrorSpy).to.have.been.calledOnce
      const errorArg = setErrorSpy.firstCall.args[0]
      expect(errorArg).to.be.instanceOf(Error)
      expect(errorArg.message).to.include('Initialization timeout')
      expect(errorArg.message).to.include('10000ms')
    })
  })
})
