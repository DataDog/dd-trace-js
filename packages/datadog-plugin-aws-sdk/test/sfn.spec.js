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

    it('generates tags for a start_execution', () => {
      const sfn = new Sfn(tracer)
      const params = {
        statemachinearn: 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      }
      expect(sfn.generateTags(params, 'start_execution', {})).to.deep.equal({
        'resource.name': 'start_execution',
        'statemachinearn': 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      })
    })

    it('generates tags for a start_execution with a name', () => {
      const sfn = new Sfn(tracer)
      const params = {
        stateMachineArn: 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2',
        name: 'my-execution'
      }
      expect(sfn.generateTags(params, 'start_execution', {})).to.deep.equal({
        'resource.name': 'start_execution my-execution',
        'statemachinearn': 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      })
    })
  })
})
