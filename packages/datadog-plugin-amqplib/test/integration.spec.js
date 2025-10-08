'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./app/test-setup')

createIntegrationTestSuite('amqplib', 'amqplib', TestSetup, {
    category: 'messaging',
    role: 'producer',  // Role doesn't matter - messaging special-cases to include both producer & consumer
    subModule: 'amqplib/callback_api',
    pluginConfig: { service: 'test' }
}, ({ testSetup, agent, expect, describe, it, beforeEach }) => {

    describe('amqplib-specific features', () => {
        it('should trace exchange publish', async function () {
            const exchangeName = 'test-exchange'
            const routingKey = 'test.route'

            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'amqp.command')
                expect(span.meta).to.have.property('span.kind', 'producer')
                expect(span.meta).to.have.property('component', 'amqplib')
                expect(span.meta).to.have.property('amqp.routingKey', routingKey)
            })

            // Create exchange and publish
            if (!testSetup.channel) {
                await testSetup.connect({})
            }
            await testSetup.channel.assertExchange(exchangeName, 'direct', { durable: false })
            testSetup.channel.publish(exchangeName, routingKey, Buffer.from('test message'))
            await assertTraces
        })

        it('should trace queue operations', async function () {
            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span).to.have.property('name', 'amqp.command')
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('component', 'amqplib')
            })

            if (!testSetup.channel) {
                await testSetup.connect({})
            }
            await testSetup.channel.checkQueue(testSetup.queueName)
            return assertTraces
        })

        it('should propagate context from producer to consumer', async function () {
            let producerTraceId
            let consumerTraceId

            // Produce a message
            await testSetup.produce({
                message: { id: 'context-test', data: 'test propagation' }
            })

            // Capture producer trace
            const agentAssertion = agent.assertSomeTraces(traces => {
                const producerSpan = traces[0][0]
                const consumerSpan = traces[0][1]
                expect(producerSpan).to.exist
                expect(producerSpan['name']).to.equal('amqp.command')
                expect(consumerSpan['name']).to.equal('amqp.receive')
            })

            // Consume the message
            const result = await testSetup.consume({
                message_id: 'context-test'
            })

            expect(result.message).to.deep.include({ id: 'context-test', data: 'test propagation' })

            return agentAssertion
        })

        it('should handle message acknowledgment', async function () {
            // Produce a message first
            await testSetup.produce({
                message: { id: 'ack-test', data: 'acknowledge me' }
            })

            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.have.property('span.kind', 'consumer')
                expect(span.meta).to.have.property('component', 'amqplib')
            })

            // Consume and acknowledge
            const result = await testSetup.consume({
                message_id: 'ack-test'
            })

            await assertTraces
            expect(result.message).to.deep.include({ id: 'ack-test' })
        })

        it('should support bulk message production', async function () {
            const messages = [
                { id: 'bulk-1', data: 'message 1' },
                { id: 'bulk-2', data: 'message 2' },
                { id: 'bulk-3', data: 'message 3' }
            ]

            const assertTraces = agent.assertSomeTraces(traces => {
                // Should have spans for each message
                expect(traces.length).to.be.at.least(1)
            })

            const result = await testSetup.produce_bulk({ messages })
            expect(result.count).to.equal(3)
            expect(result.results).to.have.lengthOf(3)

            await assertTraces
        })

        it('should handle consumer message processing', async function () {
            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.have.property('span.kind', 'consumer')
                expect(span.meta).to.have.property('component', 'amqplib')
            })

            const result = await testSetup.process({
                trigger_message: { id: 'process-test', data: 'process this' }
            })

            expect(result.processed).to.be.true
            expect(result.message).to.deep.include({ id: 'process-test', data: 'process this' })

            await assertTraces
        })

        it('should trace connection establishment', async function () {
            // Close existing connection if any
            if (testSetup.connection) {
                await testSetup.disconnect({})
            }

            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.have.property('component', 'amqplib')
                expect(span.meta).to.have.property('out.host', 'localhost')
            })

            await testSetup.connect({})
            expect(testSetup.connection).to.exist
            expect(testSetup.channel).to.exist

            await assertTraces
        })

        it('should handle message with custom properties', async function () {
            if (!testSetup.channel) {
                await testSetup.connect({})
            }

            const message = { id: 'custom-props', data: 'with properties' }
            const content = Buffer.from(JSON.stringify(message))

            const assertTraces = agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.have.property('span.kind', 'producer')
                expect(span.meta).to.have.property('component', 'amqplib')
            })

            // Send with custom properties
            testSetup.channel.sendToQueue(testSetup.queueName, content, {
                contentType: 'application/json',
                contentEncoding: 'utf-8',
                persistent: true,
                priority: 5
            })

            await new Promise(resolve => setTimeout(resolve, 100))

            await assertTraces
        })

        it('should handle queue deletion', async function () {
            const tempQueueName = 'temp-queue-delete'

            if (!testSetup.channel) {
                await testSetup.connect({})
            }

            await agent.assertSomeTraces(traces => {
                const span = traces[0][0]
                expect(span.meta).to.have.property('span.kind', 'client')
                expect(span.meta).to.have.property('component', 'amqplib')
            })

            // Create and delete queue
            await testSetup.channel.assertQueue(tempQueueName, { durable: false })
            await testSetup.channel.deleteQueue(tempQueueName)
            await assertTraces
        })

        it('should trace message redelivery on nack', async function () {
            if (!testSetup.channel) {
                await testSetup.connect({})
            }

            // Produce a message
            await testSetup.produce({
                message: { id: 'nack-test', data: 'will be nacked' }
            })

            const assertTraces = agent.assertSomeTraces(traces => {
                // Should have producer and consumer spans
                expect(traces.length).to.be.at.least(1)
            })

            // Set up consumer that nacks the message
            await new Promise((resolve) => {
                let nacked = false
                testSetup.channel.consume(testSetup.queueName, (msg) => {
                    if (msg === null || nacked) return

                    const content = JSON.parse(msg.content.toString())
                    if (content.id === 'nack-test') {
                        testSetup.channel.nack(msg, false, true) // Requeue
                        nacked = true
                        resolve()
                    }
                }, { noAck: false })
            })

            await assertTraces
        })
    })
})

