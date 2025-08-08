'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { setup } = require('./spec_helpers')

const helloWorldSMD = {
  Comment: 'A Hello World example of the Amazon States Language using a Pass state',
  StartAt: 'HelloWorld',
  States: {
    HelloWorld: {
      Type: 'Pass',
      Result: 'Hello World!',
      End: true
    }
  }
}

describe('Sfn', () => {
  let tracer

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
          },
          describeExecution: function () {
            const req = new lib.DescribeExecutionCommand(...arguments)
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
          startExecution: function () { return client.startExecution(...arguments).promise() },
          describeExecution: function () { return client.describeExecution(...arguments).promise() }
        }
      }
    }

    async function createStateMachine (name, definition, xargs) {
      return client.createStateMachine({
        definition: JSON.stringify(definition),
        name,
        roleArn: 'arn:aws:iam::123456:role/test',
        ...xargs
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

        afterEach(() => { return agent.close({ ritmReset: false }) })

        afterEach(async () => {
          await deleteStateMachine(stateMachineArn)
        })

        it('is instrumented', async function () {
          const startExecInput = {
            stateMachineArn,
            input: JSON.stringify({ moduleName })
          }
          const expectSpanPromise = agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            expect(span).to.have.property('resource', 'startExecution')
            expect(span.meta).to.have.property('statemachinearn', stateMachineArn)
          })

          const resp = await client.startExecution(startExecInput)

          const result = await client.describeExecution({ executionArn: resp.executionArn })
          const sfInput = JSON.parse(result.input)
          expect(sfInput).to.have.property('_datadog')
          expect(sfInput._datadog).to.have.property('x-datadog-trace-id')
          expect(sfInput._datadog).to.have.property('x-datadog-parent-id')
          return expectSpanPromise.then(() => {})
        })
      }
    })
  })
})
