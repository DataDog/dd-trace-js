'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const agent = require('../../dd-trace/test/plugins/agent')
const { setup, withAwsSdkVersions } = require('./spec_helpers')
const helloWorldSMD = {
  Comment: 'A Hello World example of the Amazon States Language using a Pass state',
  StartAt: 'HelloWorld',
  States: {
    HelloWorld: {
      Type: 'Pass',
      Result: 'Hello World!',
      End: true,
    },
  },
}

describe('Sfn', () => {
  let tracer

  withAwsSdkVersions((version, moduleName) => {
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
          createStateMachine: function (...args) {
            const req = new lib.CreateStateMachineCommand(...args)
            return client.send(req)
          },
          deleteStateMachine: function (...args) {
            const req = new lib.DeleteStateMachineCommand(...args)
            return client.send(req)
          },
          startExecution: function (...args) {
            const req = new lib.StartExecutionCommand(...args)
            return client.send(req)
          },
          describeExecution: function (...args) {
            const req = new lib.DescribeExecutionCommand(...args)
            return client.send(req)
          },
        }
      } else {
        const { StepFunctions } = require(`../../../versions/aws-sdk@${version}`).get()
        const client = new StepFunctions(params)
        return {
          client,
          createStateMachine: function (...args) { return client.createStateMachine(...args).promise() },
          deleteStateMachine: function (...args) {
            return client.deleteStateMachine(...args).promise()
          },
          startExecution: function (...args) { return client.startExecution(...args).promise() },
          describeExecution: function (...args) { return client.describeExecution(...args).promise() },
        }
      }
    }

    async function createStateMachine (name, definition, xargs) {
      return client.createStateMachine({
        definition: JSON.stringify(definition),
        name,
        roleArn: 'arn:aws:iam::123456:role/test',
        ...xargs,
      })
    }

    async function deleteStateMachine (arn) {
      return client.deleteStateMachine({ stateMachineArn: arn })
    }

    describe('Traces', () => {
      before(() => {
        tracer = require('../../dd-trace')
        tracer.use('aws-sdk')
      })
      // aws-sdk v2 doesn't support StepFunctions below 2.7.10
      // https://github.com/aws/aws-sdk-js/blob/5dba638fd/CHANGELOG.md?plain=1#L18
      if (moduleName !== 'aws-sdk' || semver.intersects(version, '>=2.7.10')) {
        beforeEach(() => { return agent.load('aws-sdk') })
        beforeEach(async () => {
          const data = await createStateMachine('helloWorld', helloWorldSMD, {})
          stateMachineArn = data.stateMachineArn
        })

        afterEach(() => { return agent.close() })

        afterEach(async () => {
          await deleteStateMachine(stateMachineArn)
        })

        it('is instrumented', async function () {
          const startExecInput = {
            stateMachineArn,
            input: JSON.stringify({ moduleName }),
          }
          const expectSpanPromise = agent.assertSomeTraces(traces => {
            const span = traces.flat().find(s => s.resource === 'startExecution')
            assert.ok(span, 'expected startExecution span')
            assert.strictEqual(span.resource, 'startExecution')
            assert.strictEqual(span.meta.statemachinearn, stateMachineArn)
          })

          const resp = await client.startExecution(startExecInput)

          const result = await client.describeExecution({ executionArn: resp.executionArn })
          const sfInput = JSON.parse(result.input)
          assert.ok(Object.hasOwn(sfInput, '_datadog'), `Available keys: ${inspect(Object.keys(sfInput))}`)
          assert.ok(
            Object.hasOwn(sfInput._datadog, 'x-datadog-trace-id'),
            `Available keys: ${inspect(Object.keys(sfInput._datadog))}`
          )
          assert.ok(
            Object.hasOwn(sfInput._datadog, 'x-datadog-parent-id'),
            `Available keys: ${inspect(Object.keys(sfInput._datadog))}`
          )
          return expectSpanPromise.then(() => {})
        })
      }
    })
  })
})
