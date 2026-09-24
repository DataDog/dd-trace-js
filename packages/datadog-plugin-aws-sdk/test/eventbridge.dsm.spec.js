'use strict'

const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const propagationHash = require('../../dd-trace/src/propagation-hash')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { callViaPromise, setup, withAwsSdkVersions } = require('./spec_helpers')

const DSM_CONFIG = { eventbridge: { dsmEnabled: true }, sqs: { dsmEnabled: true } }

describe('EventBridge', function () {
  this.timeout(10000)
  setup()

  withAwsSdkVersions((version, moduleName) => {
    let eventbridge
    let expectedHashes
    let producerHashes

    const eventbridgeClientName = moduleName === '@aws-sdk/smithy-client'
      ? '@aws-sdk/client-eventbridge'
      : 'aws-sdk'

    before(async function () {
      eventbridge = getEventBridgeClient()
      if (!eventbridge) {
        this.skip()
      }

      await agent.load('aws-sdk', DSM_CONFIG, { dsmEnabled: true })

      const tracer = require('../../dd-trace')
      tracer.use('aws-sdk', DSM_CONFIG)

      const phash = propagationHash.getHash()
      producerHashes = new Map(['invoice.created', 'invoice.paid'].map(detailType => [
        detailType,
        computePathwayHash(
          'test',
          'tester',
          ['direction:out', 'exchange:default', `topic:${detailType}`, 'type:eventbridge'],
          ENTRY_PARENT_HASH,
          phash
        ),
      ]))
      expectedHashes = new Map([...producerHashes].map(([detailType, hash]) => [
        detailType,
        hash.readBigUInt64LE(0).toString(),
      ]))
    })

    after(() => {
      if (!eventbridge) return
      return agent.close()
    })

    afterEach(() => {
      if (!eventbridge) return
      agent.reload('aws-sdk', DSM_CONFIG, { dsmEnabled: true })
    })

    it('injects the expected DSM pathway hash during EventBridge putEvents', async () => {
      await Promise.all([
        expectPutEventsPathwayHash(expectedHashes.get('invoice.created')),
        callViaPromise(eventbridge, 'putEvents', {
          Entries: [{
            Detail: '{"id":1}',
            DetailType: 'invoice.created',
            Source: 'checkout',
          }],
        }),
      ])
    })

    it('checkpoints every entry of a batch under its own detail type', async () => {
      await Promise.all([
        // The span carries the hash of the checkpoint set last, so a batch that only checkpointed
        // its first entry would report `invoice.created` here.
        expectPutEventsPathwayHash(expectedHashes.get('invoice.paid')),
        callViaPromise(eventbridge, 'putEvents', {
          Entries: [
            { Detail: '{"id":1}', DetailType: 'invoice.created', Source: 'checkout' },
            { Detail: '{"id":2}', DetailType: 'invoice.paid', Source: 'checkout' },
          ],
        }),
      ])
    })

    // Everything above asserts the producer side against a mock agent. Only a real delivery proves
    // the context survives AWS: EventBridge re-wraps `Detail` into an envelope's `detail` field, so
    // a consumer that looks anywhere else silently starts a fresh pathway instead of extending this
    // one.
    describe('delivered to an SQS queue', () => {
      const detailType = 'invoice.created'
      let sqs
      let queueName
      let queueUrl
      let ruleName

      before(function () {
        sqs = getSqsClient()
        if (!sqs) this.skip()
      })

      beforeEach(async () => {
        const id = randomUUID()
        queueName = `EB_TO_SQS-${id}`
        ruleName = `EB_TO_SQS_RULE-${id}`

        const { QueueUrl } = await callViaPromise(sqs, 'createQueue', { QueueName: queueName })
        queueUrl = QueueUrl
        const { Attributes } = await callViaPromise(sqs, 'getQueueAttributes', {
          AttributeNames: ['QueueArn'],
          QueueUrl: queueUrl,
        })
        const queueArn = Attributes.QueueArn

        // Without a policy the rule silently drops every delivery.
        await callViaPromise(sqs, 'setQueueAttributes', {
          Attributes: {
            Policy: JSON.stringify({
              Statement: [{
                Action: 'sqs:SendMessage',
                Effect: 'Allow',
                Principal: { Service: 'events.amazonaws.com' },
                Resource: queueArn,
              }],
              Version: '2012-10-17',
            }),
          },
          QueueUrl: queueUrl,
        })
        await callViaPromise(eventbridge, 'putRule', {
          EventPattern: JSON.stringify({ source: ['checkout'] }),
          Name: ruleName,
          State: 'ENABLED',
        })
        await callViaPromise(eventbridge, 'putTargets', {
          Rule: ruleName,
          Targets: [{ Arn: queueArn, Id: 'sqs-target' }],
        })
      })

      afterEach(async () => {
        // Each cleanup runs even when an earlier one fails, so a broken assertion cannot leave a
        // rule behind that keeps matching the next test's events.
        await Promise.allSettled([
          callViaPromise(eventbridge, 'removeTargets', { Ids: ['sqs-target'], Rule: ruleName })
            .then(() => callViaPromise(eventbridge, 'deleteRule', { Name: ruleName })),
          callViaPromise(sqs, 'deleteQueue', { QueueUrl: queueUrl }),
        ])
      })

      it('extends the producer pathway into the SQS consumer checkpoint', async () => {
        const expectedConsumerHash = computePathwayHash(
          'test',
          'tester',
          ['direction:in', `topic:${queueName}`, 'type:sqs'],
          producerHashes.get(detailType),
          propagationHash.getHash()
        ).readBigUInt64LE(0).toString()

        const statsPromise = agent.expectPipelineStats(() => {
          assert.strictEqual(agent.dsmStatsExist(agent, expectedConsumerHash), true)
        }, { timeoutMs: 8000 })

        const deliveryPromise = (async () => {
          await callViaPromise(eventbridge, 'putEvents', {
            Entries: [{
              Detail: JSON.stringify({ id: 1 }),
              DetailType: detailType,
              Source: 'checkout',
            }],
          })

          const message = await receiveDeliveredMessage()
          const envelope = JSON.parse(message.Body)

          assert.strictEqual(envelope['detail-type'], detailType)
          assert.strictEqual(envelope.detail.id, 1)
          assert.strictEqual(envelope.detail._datadog['dd-pathway-ctx-base64'].length, 28)
        })()

        await Promise.all([statsPromise, deliveryPromise])
      })

      /**
       * EventBridge delivers asynchronously, so a single receive can return nothing at all. Every
       * poll goes through the instrumented client because the consumer checkpoint under test is set
       * on the receive that actually returns the message.
       *
       * @returns {Promise<object>}
       */
      async function receiveDeliveredMessage () {
        for (let attempt = 0; attempt < 5; attempt++) {
          const { Messages } = await callViaPromise(sqs, 'receiveMessage', {
            MessageAttributeNames: ['.*'],
            QueueUrl: queueUrl,
            WaitTimeSeconds: 1,
          })
          if (Messages?.length) return Messages[0]
        }
        throw new Error(`EventBridge delivered no message to ${queueName}`)
      }

      function getSqsClient () {
        const sqsClientName = moduleName === '@aws-sdk/smithy-client' ? '@aws-sdk/client-sqs' : 'aws-sdk'
        const lib = require(`../../../versions/${sqsClientName}@${version}`).get()
        return lib.SQS ? new lib.SQS({ endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' }) : undefined
      }
    })

    /**
     * @param {string} expectedHash
     */
    function expectPutEventsPathwayHash (expectedHash) {
      let putEventsSpanMeta = {}

      return agent.assertSomeTraces(traces => {
        const span = traces[0][0]

        if (span.resource.startsWith('putEvents')) {
          putEventsSpanMeta = span.meta
        }

        assertObjectContains(putEventsSpanMeta, {
          'pathway.hash': expectedHash,
        })
      }, { timeoutMs: 5000 })
    }

    function getEventBridgeClient () {
      const params = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' }
      const lib = require(`../../../versions/${eventbridgeClientName}@${version}`).get()

      if (moduleName === '@aws-sdk/smithy-client') {
        const { NodeHttpHandler } = require(`../../../versions/@aws-sdk/node-http-handler@${version}`).get()

        params.requestHandler = new NodeHttpHandler()
        return new lib.EventBridge(params)
      }

      const EventBridge = lib.EventBridge || lib.CloudWatchEvents
      // Older aws-sdk fixtures predate this service entirely, so there is no
      // client we can instantiate for an integration test.
      if (!EventBridge) return
      return new EventBridge(params)
    }
  })
})
