/* eslint-disable max-len */
'use strict'

const Stepfunctions = require('../src/services/stepfunctions')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { setup } = require('./spec_helpers')

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
  let tracer
  let traceId
  let parentId
  let spanId

  describe('Injection behaviour', () => {
    before(() => {
      tracer = require('../../dd-trace')
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

  withVersions('aws-sdk', ['aws-sdk', '@aws-sdk/smithy-client'], (version, moduleName) => {
    let stateMachineArn
    let client

    setup()

    before(() => {
      client = getClient()
    })

    function getClient () {
      const params = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' }
      if (moduleName === '@aws-sdk/smithy-client') {
        const lib = require(`../../../versions/@aws-sdk/client-sfn@${version}`).get()
        const client = new lib.SFNClient(params)
        return {
          client,
          createStateMachine: function () {
            const req = new lib.CreateStateMachineCommand(...arguments)
            return client.send(req)
          },
          deleteStateMachine: function () {
            const req = new lib.DeleteStateMachineCommand(...arguments)
            return client.send(req)
          },
          startExecution: function () {
            const req = new lib.StartExecutionCommand(...arguments)
            return client.send(req)
          }
        }
      } else {
        const { StepFunctions } = require(`../../../versions/aws-sdk@${version}`).get()
        const client = new StepFunctions(params)
        return {
          client,
          createStateMachine: function () { return client.createStateMachine(...arguments).promise() },
          deleteStateMachine: function () {
            return client.deleteStateMachine(...arguments).promise()
          },
          startExecution: function () { return client.startExecution(...arguments).promise() }
        }
      }
    }

    async function createStateMachine (name, definition, xargs) {
      return client.createStateMachine({
        definition: JSON.stringify(definition),
        name: name,
        roleArn: 'arn:aws:iam::123456:role/test',
        ...xargs
      })
    }

    async function deleteStateMachine (arn) {
      return client.deleteStateMachine({ 'stateMachineArn': arn })
    }

    before(() => {
      tracer = require('../../dd-trace')
      tracer.use('aws-sdk')
    })

    // aws-sdk v2 doesn't support StepFunctions below 2.7.10
    // https://github.com/aws/aws-sdk-js/blob/5dba638fd/CHANGELOG.md?plain=1#L18
    if (moduleName !== 'aws-sdk' || semver.intersects(version, '>=2.7.10')) {
      beforeEach(async () => {
        const data = await createStateMachine('helloWorld', helloWorldSMD, {})
        stateMachineArn = data.stateMachineArn
      })

      afterEach(async () => {
        await deleteStateMachine(stateMachineArn)
      })

      it('is instrumented', async () => {
        agent.use(traces => {
          const span = traces[0][0]

          // eslint-disable-next-line no-console
          console.log(span)

          // expect(span).to.have.property('name', 'aws.stepfunctions')
          expect(1).to.equal(2)
        })

        await client.startExecution({
          stateMachineArn,
          input: JSON.stringify({})
        })
      })
    }
  })
})
