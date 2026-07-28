'use strict'

const { after, afterEach, before, describe, it } = require('mocha')

const { computePathwayHash } = require('../../dd-trace/src/datastreams/pathway')
const { ENTRY_PARENT_HASH } = require('../../dd-trace/src/datastreams/processor')
const propagationHash = require('../../dd-trace/src/propagation-hash')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { callViaPromise, setup, withAwsSdkVersions } = require('./spec_helpers')

describe('EventBridge', function () {
  this.timeout(10000)
  setup()

  withAwsSdkVersions((version, moduleName) => {
    let eventbridge
    let expectedHashes

    const eventbridgeClientName = moduleName === '@aws-sdk/smithy-client'
      ? '@aws-sdk/client-eventbridge'
      : 'aws-sdk'

    before(async function () {
      eventbridge = getEventBridgeClient()
      if (!eventbridge) {
        this.skip()
      }

      await agent.load('aws-sdk', { eventbridge: { dsmEnabled: true } }, { dsmEnabled: true })

      const tracer = require('../../dd-trace')
      tracer.use('aws-sdk', { eventbridge: { dsmEnabled: true } })

      const phash = propagationHash.getHash()
      expectedHashes = new Map(['invoice.created', 'invoice.paid'].map(detailType => [
        detailType,
        computePathwayHash(
          'test',
          'tester',
          ['direction:out', 'exchange:default', `topic:${detailType}`, 'type:eventbridge'],
          ENTRY_PARENT_HASH,
          phash
        ).readBigUInt64LE(0).toString(),
      ]))
    })

    after(() => {
      if (!eventbridge) return
      return agent.close()
    })

    afterEach(() => {
      if (!eventbridge) return
      agent.reload('aws-sdk', { eventbridge: { dsmEnabled: true } }, { dsmEnabled: true })
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
      })
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
