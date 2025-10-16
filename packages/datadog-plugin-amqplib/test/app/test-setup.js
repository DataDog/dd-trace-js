'use strict'

class AmqplibTestSetup {
    async setup (module) {
        this.amqplib = module

        // Only initialize once
        if (!this.queueName) {
            this.queueName = 'test-queue-amqplib'
            this.consumerTags = []
            this.messages = []
        }

        // Reuse existing connection if available
        if (this.connection && this.channel) {
            return Promise.resolve()
        }

        // Establish connection and create channel
        return new Promise((resolve, reject) => {
            module.connect((err, conn) => {
                if (err) return reject(err)
                this.connection = conn

                conn.createChannel((err, ch) => {
                    if (err) return reject(err)
                    this.channel = ch

                    // Assert the queue exists
                    ch.assertQueue(this.queueName, {}, (err) => {
                        if (err) return reject(err)
                        resolve()
                    })
                })
            })
        })
    }

    async teardown () {
        // Wait a bit for any pending message deliveries to complete
        await new Promise(resolve => setTimeout(resolve, 100))

        // Close everything - channel close will auto-cancel consumers
        return new Promise((resolve) => {
            // Add timeout to prevent hanging
            const timeout = setTimeout(() => {
                this.channel = null
                this.connection = null
                this.consumerTags = []
                resolve()
            }, 2000)

            const cleanup = () => {
                clearTimeout(timeout)
                this.channel = null
                this.connection = null
                this.consumerTags = []
                resolve()
            }

            if (this.channel) {
                // Purge queue to remove unacked messages
                this.channel.purgeQueue(this.queueName, (err) => {
                    // Ignore errors, continue cleanup
                    // Close channel (this auto-cancels all consumers)
                    this.channel.close((err) => {
                        // Ignore errors
                        if (this.connection) {
                            this.connection.close((err) => {
                                // Ignore errors
                                cleanup()
                            })
                        } else {
                            cleanup()
                        }
                    })
                })
            } else if (this.connection) {
                this.connection.close((err) => {
                    // Ignore errors
                    cleanup()
                })
            } else {
                cleanup()
            }
        })
    }

    async connect ({ expectError } = {}) {
        // If amqplib module not loaded, can't connect
        if (!this.amqplib) {
            throw new Error('amqplib module not loaded - setup() must be called first')
        }

        if (expectError) {
            // Trigger real connection error with invalid host
            return new Promise((resolve, reject) => {
                this.amqplib.connect('amqp://invalid-host-does-not-exist:9999', (err) => {
                    if (err) reject(err)
                    else resolve()
                })
            })
        }

        // Connection already established in setup()
        if (this.connection && this.channel) {
            return { status: 'connected' }
        }

        // Fallback: establish connection if not already done
        return new Promise((resolve, reject) => {
            this.amqplib.connect((err, conn) => {
                if (err) return reject(err)
                this.connection = conn

                conn.createChannel((err, ch) => {
                    if (err) return reject(err)
                    this.channel = ch

                    ch.assertQueue(this.queueName, {}, (err) => {
                        if (err) return reject(err)
                        resolve({ status: 'connected' })
                    })
                })
            })
        })
    }

    async produce ({ message, expectError }) {
        if (message === undefined) {
            message = { data: 'test-message' }
        }

        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid content (string instead of Buffer)
            this.channel.sendToQueue(this.queueName, 'invalid-not-a-buffer')
            return
        }

        const content = Buffer.from(JSON.stringify(message))
        const result = this.channel.sendToQueue(this.queueName, content)

        // Give time for message to be published
        await new Promise(resolve => setTimeout(resolve, 50))

        return { sent: result, messageId: message.id || Date.now().toString() }
    }

    async produce_bulk ({ messages, expectError }) {
        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid message array (send each as string)
            for (const message of messages) {
                this.channel.sendToQueue(this.queueName, 'invalid-not-a-buffer')
            }
            return
        }

        const results = []
        for (const message of messages) {
            const content = Buffer.from(JSON.stringify(message))
            const result = this.channel.sendToQueue(this.queueName, content)
            results.push({ sent: result, messageId: message.id || Date.now().toString() })
        }

        // Give time for messages to be published
        await new Promise(resolve => setTimeout(resolve, 100))

        return { count: results.length, results }
    }

    async consume ({ message_id, expectError }) {
        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid queue name (null)
            return this.channel.consume(null, () => {}, { noAck: false })
        }

        return new Promise((resolve, reject) => {
            this.channel.consume(this.queueName, (msg) => {
                if (msg === null || !this.channel) {
                    return
                }

                try {
                    const content = JSON.parse(msg.content.toString())

                    // If message_id specified, only resolve for that message
                    if (message_id && content.id !== message_id) {
                        return
                    }

                    this.channel.ack(msg)
                    resolve({
                        message: content,
                        fields: msg.fields,
                        properties: msg.properties
                    })
                } catch (err) {
                    if (this.channel) {
                        this.channel.nack(msg)
                    }
                    reject(err)
                }
            }, { noAck: false }, (err, result) => {
                if (err) return reject(err)
                // Track consumer tag for cleanup
                if (result.consumerTag) {
                    this.consumerTags.push(result.consumerTag)
                }
            })
        })
    }

    async process ({ trigger_message, expectError }) {
        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid queue name to consume
            return this.channel.consume(null, () => {}, { noAck: false })
        }

        // Default trigger message if not provided
        if (trigger_message === undefined) {
            trigger_message = { data: 'trigger-message' }
        }

        // Set up consumer
        return new Promise((resolve, reject) => {
            this.channel.consume(this.queueName, (msg) => {
                if (msg === null || !this.channel) return

                const content = JSON.parse(msg.content.toString())
                if (this.channel) {
                    this.channel.ack(msg)
                }

                resolve({
                    processed: true,
                    message: content,
                    fields: msg.fields
                })
            }, { noAck: false }, (err, result) => {
                if (err) return reject(err)

                // Track consumer tag for cleanup
                if (result.consumerTag) {
                    this.consumerTags.push(result.consumerTag)
                }

                // Produce the trigger message
                const content = Buffer.from(JSON.stringify(trigger_message))
                if (this.channel) {
                    this.channel.sendToQueue(this.queueName, content)
                }
            })
        })
    }

    async acknowledge ({ message, expectError }) {
        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid message (null or wrong type)
            this.channel.ack(null)
            return
        }

        // For this operation, we need a real message object
        // In a real scenario, this would come from consume()
        if (message._amqpMessage) {
            this.channel.ack(message._amqpMessage)
            return { acknowledged: true }
        }

        return { acknowledged: false, reason: 'No message to acknowledge' }
    }

    async reject ({ message, expectError }) {
        if (!this.channel) {
            await this.connect({})
        }

        if (expectError) {
            // Trigger real error by passing invalid message (null or wrong type)
            this.channel.nack(null, false, false)
            return
        }

        // For this operation, we need a real message object
        if (message._amqpMessage) {
            this.channel.nack(message._amqpMessage, false, false)
            return { rejected: true }
        }

        return { rejected: false, reason: 'No message to reject' }
    }

    async disconnect ({ expectError }) {
        if (expectError) {
            // Trigger real error by calling close on already closed channel
            if (this.channel) {
                await this.channel.close()
                this.channel = null
            }
            // Try to close already closed channel
            if (this.connection) {
                await this.connection.close()
                await this.connection.close() // Double close triggers error
            }
            return
        }

        if (this.channel) {
            await this.channel.close()
            this.channel = null
        }

        if (this.connection) {
            await this.connection.close()
            this.connection = null
        }

        return { status: 'disconnected' }
    }
}

module.exports = AmqplibTestSetup

