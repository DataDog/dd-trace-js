'use strict'

const assert = require('node:assert/strict')

const { after, afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  describe('rhea', function () {
    before(() => {
      process.env.DD_DATA_STREAMS_ENABLED = 'true'
    })

    after(() => agent.close({ ritmReset: false }))

    withVersions('rhea', 'rhea', version => {
      describe('data stream monitoring', function () {
        this.timeout(30000)
        let container
        let connection

        beforeEach(() => {
          return agent.load('rhea', { dsmEnabled: true })
        })

        afterEach(() => {
          container?.removeAllListeners('message')
          connection?.close()
          connection = null
          return agent.close({ ritmReset: false })
        })

        describe('concurrent context isolation', () => {
          it('Should maintain separate DSM context for sequential consume-produce flows', (done) => {
            const setCheckpointSpy = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')
            container = require(`../../../versions/rhea@${version}`).get()

            // Use pre-existing Qpid addresses to avoid "Node not found"
            const addrAIn = 'amq.topic'
            const addrBIn = 'amq.fanout'
            const addrAOut = 'amq.direct'
            const addrBOut = 'amq.match'

            let finished = false
            let messageCount = 0

            const finish = (err) => {
              if (finished) return
              finished = true
              container.removeListener('message', onMessage)
              setCheckpointSpy.restore()
              done(err)
            }

            const checkAssertions = () => {
              const calls = setCheckpointSpy.getCalls()

              try {
                const checkpoint = (dir, tag) => calls.find(c =>
                  c.args[0].includes(`direction:${dir}`) && c.args[0].includes(tag)
                )

                const consumeA = checkpoint('in', `topic:${addrAIn}`)
                const consumeB = checkpoint('in', `topic:${addrBIn}`)
                const produceA = checkpoint('out', `exchange:${addrAOut}`)
                const produceB = checkpoint('out', `exchange:${addrBOut}`)

                assert.ok(produceA?.args[2], 'Process A produce should have a parent DSM context')
                assert.ok(produceB?.args[2], 'Process B produce should have a parent DSM context')
                assert.deepStrictEqual(produceA.args[2].hash, consumeA.returnValue.hash)
                assert.deepStrictEqual(produceB.args[2].hash, consumeB.returnValue.hash)
                finish()
              } catch (e) {
                finish(e)
              }
            }

            const onMessage = msg => {
              const address = msg.receiver?.options?.source?.address
              if (address === addrAIn) {
                senderAOut.send({ body: 'from-a' })
              } else if (address === addrBIn) {
                senderBOut.send({ body: 'from-b' })
              } else {
                return
              }
              if (++messageCount === 2) checkAssertions()
            }

            container.on('message', onMessage)

            connection = container.connect({
              username: 'admin',
              password: 'admin',
              host: 'localhost',
              port: 5673,
            })

            const senderAOut = connection.open_sender(addrAOut)
            const senderBOut = connection.open_sender(addrBOut)
            connection.open_receiver(addrAIn)
            connection.open_receiver(addrBIn)

            const senderA = connection.open_sender(addrAIn)
            const senderB = connection.open_sender(addrBIn)

            // Wait for input senders to be sendable before seeding messages
            let readyCount = 0
            const sendWhenReady = () => {
              if (++readyCount < 2) return
              senderA.send({ body: 'msg-a' })
              senderB.send({ body: 'msg-b' })
            }
            senderA.once('sendable', sendWhenReady)
            senderB.once('sendable', sendWhenReady)
          })
        })
      })
    })
  })
})
