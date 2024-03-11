/* eslint-disable max-len */
'use strict'

const Stepfunctions = require('../src/services/stepfunctions')
const tracer = require('../../dd-trace')
const agent = require('../../dd-trace/test/plugins/agent')

const helloWorldSMD = {
  'Comment': 'A Hello World example of the Amazon States Language using a Pass state',
  'StartAt': 'HelloWorld',
  'States': {
    'HelloWorld': {
      'Type': 'Pass',
      'Result': 'Hello World!',
      'End': true
    }
  }
}

describe('Sfn', () => {
  let span
  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let traceId
    let parentId
    let spanId
    let client
    let stateMachineArn

    function getClient (moduleName) {
      if (moduleName === '@aws-sdk/smithy-client') {
        const { SFNClient } = require(`../../../versions/@aws-sdk/client-sfn@${version}`).get()
        return SFNClient
      } else {
        const { StepFunctions } = require(`../../../versions/aws-sdk@${version}`).get()
        return StepFunctions
      }
    }

    function createStateMachine (name, definition, xargs, done) {
      client = getClient({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' })
      client.createStateMachine({
        definition: JSON.stringify(definition),
        name: name,
        ...xargs
      }, (err, data) => {
        if (err) {
          done(err)
        }
        stateMachineArn = data.stateMachineArn
      })
    }

    function deleteStateMachine (arn, done) {
      client.deleteStateMachine({ stateMachineArn: arn }, (err, data) => {
        if (err) done(err)
      })
    }

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

    beforeEach(done => createStateMachine('helloWorld', helloWorldSMD, done))

    afterEach(done => deleteStateMachine(stateMachineArn, done))

    it('is instrumented', done => {
      agent.use(traces => {
        const span = traces[0][0]

        expect(span).to.have.property('name', 'aws.stepfunctions')
      })

      client.startExecution({
        stateMachineArn,
        name: 'helloWorldExecution',
        input: JSON.stringify({})
      }, err => err && done(err))
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
