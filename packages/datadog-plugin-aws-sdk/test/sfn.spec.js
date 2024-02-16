/* eslint-disable max-len */
'use strict'

const Sfn = require('../src/services/sfn')
const tracer = require('../../dd-trace')

describe('Sfn', () => {
  let span
  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let traceId
    let parentId
    let spanId
    before(() => {
      tracer.init()
      span = {
        finish: sinon.spy(() => {}),
        context: () => {
          return {
            _sampling: {
              priority: 1
            },
            _trace: {
              started: [],
              origin: ''
            },
            _traceFlags: {
              sampled: 1
            },
            'x-datadog-trace-id': traceId,
            'x-datadog-parent-id': parentId,
            'x-datadog-sampling-priority': '1',
            toTraceId: () => {
              return traceId
            },
            toSpanId: () => {
              return spanId
            }
          }
        },
        addTags: sinon.stub(),
        setTag: sinon.stub()
      }
      tracer._tracer.startSpan = sinon.spy(() => {
        return span
      })
    })

    it('generates tags for an event', () => {
      const eventbridge = new Sfn(tracer)
      const params = {
        statemachinearn: 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      }
      expect(eventbridge.generateTags(params, 'start_execution', {})).to.deep.equal({
        'resource.name': 'start_execution',
        'statemachinearn': 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      })
    })
  })
})
