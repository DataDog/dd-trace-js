'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const path = require('node:path')

const agent = require('../plugins/agent')

const oldEnv = process.env
/**
 * Sets up the minimum environment variables to make sure
 * the tracer works as expected for an AWS Lambda function.
 */
const setup = () => {
  const newEnv = {
    LAMBDA_TASK_ROOT: './packages/dd-trace/test/lambda/fixtures',
    AWS_LAMBDA_FUNCTION_NAME: 'mock-function-name',
    DD_TRACE_ENABLED: 'true',
    DD_LOG_LEVEL: 'debug'
  }
  process.env = { ...oldEnv, ...newEnv }
}

const restoreEnv = () => {
  process.env = oldEnv
}

/**
 * Loads the test agent and makes sure the hook for the
 * AWS Lambda function patch is re-registered.
 *
 * @param {*} exporter defines the type of exporter for the test agent.
 * @returns a promise of the agent to load.
 */
const loadAgent = ({ exporter = 'agent' } = {}) => {
  // Make sure the hook is re-registered
  require('../../src/lambda')
  return agent.load([], [], {
    experimental: {
      exporter
    }
  })
}

/**
 * Closes the test agent, resets the ritm modules and ensures
 * the cache for the AWS Lambda function patch is deleted so the hook
 * is re-registered once the ritm calls it.
 */
const closeAgent = () => {
  // In testing, the patch needs to be deleted from the require cache,
  // in order to allow multiple handlers being patched properly.
  delete require.cache[require.resolve('../../src/lambda/runtime/patch.js')]
  delete require.cache[require.resolve('../../src/lambda')]

  agent.close({ ritmReset: true })
}

describe('lambda', () => {
  let datadog

  describe('patch', () => {
    beforeEach(setup)

    afterEach(() => {
      restoreEnv()
      return closeAgent()
    })

    it('patches lambda function correctly', async () => {
      // Set the desired handler to patch
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      // Load the agent and re-register hook for patching.
      await loadAgent()

      const _context = {
        getRemainingTimeInMillis: () => 150
      }
      const _event = {}

      // Mock `datadog-lambda` handler resolve and import.
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      // Run the function.
      const result = await datadog(app.handler)(_event, _context)

      expect(result).to.not.equal(undefined)
      const body = JSON.parse(result.body)
      expect(body.message).to.equal('hello!')

      // Expect traces to be correct.
      const checkTraces = agent.assertSomeTraces((_traces) => {
        const traces = _traces[0]
        expect(traces).lengthOf(1)
        traces.forEach((trace) => {
          expect(trace.error).to.equal(0)
        })
      })
      await checkTraces
    })

    it('patches lambda function with callback correctly', async () => {
      // Set the desired handler to patch
      process.env.DD_LAMBDA_HANDLER = 'handler.callbackHandler'
      // Load the agent and re-register hook for patching.
      await loadAgent()

      const _context = {
        getRemainingTimeInMillis: () => 150
      }
      const _event = {}

      // Mock `datadog-lambda` handler resolve and import.
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      let result
      const callback = (_error, res) => {
        result = res
      }
      // Run the function.
      datadog(app.callbackHandler)(_event, _context, callback)

      expect(result).to.not.equal(undefined)
      const body = JSON.parse(result.body)
      expect(body.message).to.equal('hello!')

      // Expect traces to be correct.
      const checkTraces = agent.assertSomeTraces((_traces) => {
        const traces = _traces[0]
        expect(traces).lengthOf(1)
        traces.forEach((trace) => {
          expect(trace.error).to.equal(0)
        })
      })
      await checkTraces
    })

    it('does wrap handler causing unhandled promise rejections', async () => {
      // Set the desired handler to patch
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      // Load the agent and re-register hook for patching.
      await loadAgent()

      const _context = {
        getRemainingTimeInMillis: () => 150
      }
      const _event = {}

      // Mock `datadog-lambda` handler resolve and import.
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      // Run the function.
      try {
        await datadog(app.errorHandler)(_event, _context)
      } catch (e) {
        expect(e.name).to.equal('CustomError')
      }

      // Expect traces to be correct.
      const checkTraces = agent.assertSomeTraces((_traces) => {
        const traces = _traces[0]
        expect(traces).lengthOf(1)
        traces.forEach((trace) => {
          expect(trace.error).to.equal(1)
        })
      })
      await checkTraces
    })

    it('correctly patch handler where context is the third argument', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.swappedArgsHandler'

      await loadAgent()

      const _context = {
        getRemainingTimeInMillis: () => 150
      }
      const _event = {}
      const _ = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')

      const result = await datadog(app.swappedArgsHandler)(_event, _, _context)

      expect(result).to.not.equal(undefined)
      const body = JSON.parse(result.body)
      expect(body.message).to.equal('hello!')

      const checkTraces = agent.assertSomeTraces((_traces) => {
        const traces = _traces[0]
        expect(traces).lengthOf(1)
        traces.forEach((trace) => {
          expect(trace.error).to.equal(0)
        })
      })
      await checkTraces
    })

    it('doesnt patch lambda when instrumentation is disabled', async () => {
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const handlerBefore = require(_handlerPath).handler

      // Set the desired handler to patch
      process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = 'lambda'
      process.env.DD_LAMBDA_HANDLER = 'handler.handler'
      // Register hook for patching
      await loadAgent()

      // Mock `datadog-lambda` handler resolve and import.
      const handlerAfter = require(_handlerPath).handler
      expect(handlerBefore).to.equal(handlerAfter)
    })
  })

  describe('timeout spans', () => {
    beforeEach(setup)

    afterEach(() => {
      restoreEnv()
      return closeAgent()
    })

    it('doesnt crash when spans are finished early and reached impending timeout', async () => {
      process.env.DD_LAMBDA_HANDLER = 'handler.finishSpansEarlyTimeoutHandler'
      await loadAgent()

      const _context = {
        getRemainingTimeInMillis: () => 25
      }
      const _event = {}

      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      const result = datadog(app.finishSpansEarlyTimeoutHandler)(_event, _context)

      const checkTraces = agent.assertSomeTraces((_traces) => {
        const traces = _traces[0]
        traces.forEach((trace) => {
          expect(trace.error).to.equal(0)
        })
      })

      return result.then(_ => {}).then(() => checkTraces)
    })

    const deadlines = [
      {
        envVar: 'default'
        // will use default remaining time
      },
      {
        envVar: 'DD_APM_FLUSH_DEADLINE_MILLISECONDS',
        value: '-100' // will default to 0
      },
      {
        envVar: 'DD_APM_FLUSH_DEADLINE_MILLISECONDS',
        value: '10' // subtract 10 from the remaining time
      }
    ]

    deadlines.forEach(deadline => {
      const flushDeadlineEnvVar = deadline.envVar
      const customDeadline = deadline.value ? deadline.value : ''

      it(`traces error on impending timeout using ${flushDeadlineEnvVar} ${customDeadline} deadline`, () => {
        process.env[flushDeadlineEnvVar] = customDeadline
        process.env.DD_LAMBDA_HANDLER = 'handler.timeoutHandler'

        const _context = {
          getRemainingTimeInMillis: () => 25
        }
        const _event = {}

        const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')

        // Load agent and patch handler.
        return loadAgent().then(_ => {
          const app = require(_handlerPath)
          datadog = require('./fixtures/datadog-lambda')

          const result = datadog(app.timeoutHandler)(_event, _context)

          const checkTraces = agent.assertSomeTraces(_traces => {
            // First trace, since errors are tagged at root span level.
            const trace = _traces[0][0]
            expect(trace.error).to.equal(1)
            expect(trace.meta['error.type']).to.equal('Impending Timeout')
            // Ensure that once this finish, an error was tagged.
          })

          // Since these are expected to timeout and one can't kill the
          // environment, one has to wait for the result to come in so
          // the traces are verified above.
          return result.then(_ => {}).then(() => checkTraces)
        })
      })
    })
  })
})
