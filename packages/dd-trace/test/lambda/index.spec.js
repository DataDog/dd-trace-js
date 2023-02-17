'use strict'

const path = require('path')
const agent = require('../plugins/agent')

describe('lambda', () => {
  let datadog
  const oldEnv = process.env

  describe('with lambda extension - agent exporter', () => {
    beforeEach(() => {
      const newEnv = {
        LAMBDA_TASK_ROOT: './packages/dd-trace/test/lambda/fixtures',
        DD_LAMBDA_HANDLER: 'handler.handler',
        AWS_LAMBDA_FUNCTION_NAME: 'my-function-name',
        DD_TRACE_ENABLED: 'true',
        DD_LOG_LEVEL: 'debug'
      }
      process.env = { ...oldEnv, ...newEnv }
      return agent.load(null, [], {
        // add experimental exporter to mock lambda extension
        experimental: {
          exporter: 'agent'
        }
      })
    })

    afterEach(() => {
      process.env = oldEnv
      return agent.close({ ritmReset: false })
    })

    it('patches lambda function correctly', async () => {
      const _context = {
        getRemainingTimeInMillis: () => 300
      }
      const _event = {}
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      const result = await datadog(app.handler)(_event, _context)

      expect(result).to.not.equal(undefined)
      const body = JSON.parse(result.body)
      expect(body.message).to.equal('hello!')
      const checkTraces = agent.use((_traces) => {
        const traces = _traces[0]
        expect(traces).lengthOf(2)
        traces.forEach((trace) => {
          expect(trace.error).to.equal(0)
        })
      })
      await checkTraces
    })

    describe('timeout spans', () => {
      const deadlines = [
        {
          envVar: 'default'
        },
        {
          envVar: 'DD_APM_FLUSH_DEADLINE_MILLISECONDS',
          value: 100
        },
        {
          envVar: 'DD_APM_FLUSH_DEADLINE',
          value: 100
        }
      ]

      deadlines.forEach(deadline => {
        const flushDeadlineEnvVar = deadline.envVar
        const customDeadline = deadline.value
        const isDefault = flushDeadlineEnvVar === 'default'

        it(`traces error on impending timeout using ${flushDeadlineEnvVar} deadline`, () => {
          process.env[flushDeadlineEnvVar] = customDeadline

          const _context = {
            // If using default, we set the value to 150, since the
            // fixture function we're using sleeps for 200ms
            getRemainingTimeInMillis: () => isDefault ? 150 : 400
          }
          const _event = {}

          const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
          const app = require(_handlerPath)
          datadog = require('./fixtures/datadog-lambda')
          let result
          (datadog(app.handler)(_event, _context)).then((data) => { result = data })

          // If default, then we don't wait for value from deadline, we just use
          // AWS Lambda remaining time in millis
          const timeoutDeadline = isDefault ? _context.getRemainingTimeInMillis() : customDeadline - 50
          setTimeout(() => {
            expect(result).to.equal(undefined)
          }, timeoutDeadline)

          const checkTraces = agent.use((_traces) => {
            // First trace, since errors are tagged at root span level.
            const trace = _traces[0][0]
            expect(trace.error).to.equal(1)
            expect(trace.meta['error.type']).to.equal('Impending Timeout')
          })

          // We change from async/await here since testing multiple tests
          // with iterators is tricky, forof won't work to use it here.
          checkTraces.then(() => {})
        })
      })
    })
  })
})
