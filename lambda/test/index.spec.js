'use strict'

const path = require('path')
const { expect } = require('chai')
const agent = require('../../packages/dd-trace/test/plugins/agent')

describe('lambda', () => {
  let datadog
  const oldEnv = process.env

  describe('with lambda extension - agent exporter', () => {
    beforeEach(() => {
      const newEnv = {
        LAMBDA_TASK_ROOT: './lambda/test/fixtures',
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
        getRemainingTimeInMillis: () => 200
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

    it('returns traces with error when handler is about to timeout', async () => {
      const _context = {
        getRemainingTimeInMillis: () => 50
      }
      const _event = {}
      const _handlerPath = path.resolve(__dirname, './fixtures/handler.js')
      const app = require(_handlerPath)
      datadog = require('./fixtures/datadog-lambda')
      let result
      (datadog(app.handler)(_event, _context)).then((data) => { result = data })
      setTimeout(() => {
        expect(result).to.equal(undefined)
      }, _context.getRemainingTimeInMillis())

      const checkTraces = agent.use((_traces) => {
        const trace = _traces[0][0]
        expect(trace.error).to.equal(1)
        expect(trace.meta['error.type']).to.equal('Impending Timeout')
      })
      await checkTraces
    })
  })
})
