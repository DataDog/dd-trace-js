'use strict'

const assert = require('node:assert/strict')
const { describe, it, before, after, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')

const DataStreamsContext = require('../../dd-trace/src/datastreams/context')
const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')

describe('Plugin', () => {
  describe('nats (DSM)', function () {
    this.timeout(20000)

    withVersions('nats', 'nats', (version) => {
      let nats
      let nc

      describe('data stream monitoring', () => {
        before(async () => {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          process.env.DD_TRACE_ENABLED = 'true'
          await agent.load('nats', { dsmEnabled: true })
          nats = require(`../../../versions/nats@${version}`).get()
        })

        after(async () => {
          delete process.env.DD_DATA_STREAMS_ENABLED
          delete process.env.DD_TRACE_ENABLED
          if (nc) {
            await nc.close()
            nc = undefined
          }
          await agent.close({ ritmReset: false })
        })

        describe('checkpoints', () => {
          let setDataStreamsContextSpy

          beforeEach(async () => {
            setDataStreamsContextSpy = sinon.spy(DataStreamsContext, 'setDataStreamsContext')
            nc = await nats.connect({ servers: '127.0.0.1:4222' })
          })

          afterEach(async () => {
            setDataStreamsContextSpy.restore()
            if (nc) {
              await nc.close()
              nc = undefined
            }
          })

          it('should set a checkpoint on produce', async () => {
            const subject = 'dsm.test.produce'
            nc.publish(subject, nats.StringCodec().encode('hello'))
            await nc.flush()

            await new Promise(resolve => setTimeout(resolve, 500))

            assert.ok(
              setDataStreamsContextSpy.callCount > 0,
              'Expected setDataStreamsContext to be called on produce'
            )
          })

          it('should set a checkpoint on consume', async () => {
            const subject = 'dsm.test.consume'
            const sub = nc.subscribe(subject, { max: 1 })

            nc.publish(subject, nats.StringCodec().encode('hello'))
            await nc.flush()

            for await (const _msg of sub) {
              // consume the message
            }

            await new Promise(resolve => setTimeout(resolve, 500))

            // At least 2 calls: one produce checkpoint + one consume checkpoint
            assert.ok(
              setDataStreamsContextSpy.callCount >= 2,
              `Expected at least 2 setDataStreamsContext calls (produce + consume), got ${setDataStreamsContextSpy.callCount}`
            )
          })

          it('should set a message payload size on produce', async () => {
            const recordCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
            try {
              const subject = 'dsm.test.payload'
              nc.publish(subject, nats.StringCodec().encode('payload-test'))
              await nc.flush()

              await new Promise(resolve => setTimeout(resolve, 500))

              assert.ok(
                recordCheckpointSpy.callCount > 0,
                'Expected recordCheckpoint to be called'
              )
              assert.ok(
                Object.hasOwn(recordCheckpointSpy.args[0][0], 'payloadSize'),
                'Expected payloadSize to be set on checkpoint'
              )
            } finally {
              recordCheckpointSpy.restore()
            }
          })
        })
      })
    })
  })
})
