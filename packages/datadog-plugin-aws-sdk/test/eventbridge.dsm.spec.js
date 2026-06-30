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
    let expectedProducerHash

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
      expectedProducerHash = computePathwayHash(
        'test',
        'tester',
        ['direction:out', 'exchange:default', 'topic:invoice.created', 'type:eventbridge'],
        ENTRY_PARENT_HASH,
        phash
      ).readBigUInt64LE(0).toString()
    })

    after(() => {
      if (!eventbridge) return
      return agent.close()
    })

    afterEach(() => {
      if (!eventbridge) return
      agent.reload('aws-sdk', { eventbridge: { dsmEnabled: true } }, { dsmEnabled: true })
    })

    it('injects the expected DSM pathway hash during EventBridge putEvents', done => {
      let putEventsSpanMeta = {}

      const tracePromise = agent.assertSomeTraces(traces => {
        const span = traces[0][0]

        if (span.resource.startsWith('putEvents')) {
          putEventsSpanMeta = span.meta
        }

        assertObjectContains(putEventsSpanMeta, {
          'pathway.hash': expectedProducerHash,
        })
      })

      Promise.all([
        tracePromise,
        callViaPromise(eventbridge, 'putEvents', {
          Entries: [{
            Detail: '{"id":1}',
            DetailType: 'invoice.created',
            Source: 'checkout',
          }],
        }),
      ]).then(() => done(), done)
    })

    function getEventBridgeClient () {
      const params = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' }
      const lib = require(`../../../versions/${eventbridgeClientName}@${version}`).get()

      if (moduleName === '@aws-sdk/smithy-client') {
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
