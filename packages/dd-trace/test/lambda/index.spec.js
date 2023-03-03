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
        getRemainingTimeInMillis: () => 150
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

        it(`traces error on impending timeout using ${flushDeadlineEnvVar} ${customDeadline} deadline`, (done) => {
          process.env[flushDeadlineEnvVar] = customDeadline

          const _context = {
            getRemainingTimeInMillis: () => 25
          }
          const _event = {}

          const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
          const app = require(_handlerPath)
          datadog = require('./fixtures/datadog-lambda')

          let error = false
          agent.use((_traces) => {
            // First trace, since errors are tagged at root span level.
            const trace = _traces[0][0]
            expect(trace.error).to.equal(1)
            error = true
            expect(trace.meta['error.type']).to.equal('Impending Timeout')
            // Ensure that once this finish, an error was tagged.
          }).then(() => expect(error).to.equal(true))

          // Since these are expected to timeout and one can't kill the
          // environment, one has to wait for the result to come in so
          // the traces are verified above.
          datadog(app.handler)(_event, _context).then(_ => done(), done)
        })
      })
    })
  })
})
