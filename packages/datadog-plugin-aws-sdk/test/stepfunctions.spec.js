/* eslint-disable max-len */
'use strict'

const Stepfunctions = require('../src/services/stepfunctions')
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
      const sfn = new Stepfunctions(tracer)
      const params = {
        stateMachineArn: 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      }
      expect(sfn.generateTags(params, 'startExecution', {})).to.deep.equal({
        'resource.name': 'startExecution',
        'statemachinearn': 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      })
    })

    it('generates tags for a start_execution with a name', () => {
      const sfn = new Stepfunctions(tracer)
      const params = {
        stateMachineArn: 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2',
        name: 'my-execution'
      }
      expect(sfn.generateTags(params, 'startExecution', {})).to.deep.equal({
        'resource.name': 'startExecution my-execution',
        'statemachinearn': 'arn:aws:states:us-east-1:425362996713:stateMachine:agocs-test-noop-state-machine-2'
      })
    })

    it('injects trace context into StepFunction start_execution requests', () => {
      const sfn = new Stepfunctions(tracer)
      const request = {
        params: {
          input: JSON.stringify({ 'foo': 'bar' })
        },
        operation: 'startExecution'
      }

      traceId = '456853219676779160'
      spanId = '456853219676779160'
      parentId = '0000000000000000'
      sfn.requestInject(span.context(), request)
      expect(request.params).to.deep.equal({ 'input': '{"foo":"bar","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}' })
    })
  })

  it('injects trace context into StepFunction start_sync_execution requests', () => {
    const sfn = new Stepfunctions(tracer)
    const request = {
      params: {
        input: JSON.stringify({ 'foo': 'bar' })
      },
      operation: 'startSyncExecution'
    }

    sfn.requestInject(span.context(), request)
    expect(request.params).to.deep.equal({ 'input': '{"foo":"bar","_datadog":{"x-datadog-trace-id":"456853219676779160","x-datadog-parent-id":"456853219676779160","x-datadog-sampling-priority":"1"}}' })
  })

  it('will not inject trace context if the input is a number', () => {
    const sfn = new Stepfunctions(tracer)
    const request = {
      params: {
        input: JSON.stringify(1024)
      },
      operation: 'startSyncExecution'
    }

    sfn.requestInject(span.context(), request)
    expect(request.params).to.deep.equal({ 'input': '1024' })
  })

  it('will not inject trace context if the input is a boolean', () => {
    const sfn = new Stepfunctions(tracer)
    const request = {
      params: {
        input: JSON.stringify(true)
      },
      operation: 'startSyncExecution'
    }

    sfn.requestInject(span.context(), request)
    expect(request.params).to.deep.equal({ 'input': 'true' })
  })
})
