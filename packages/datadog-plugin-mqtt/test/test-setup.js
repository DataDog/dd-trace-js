'use strict'

const BROKER_URL = 'mqtt://127.0.0.1:1883'
const TEST_TOPIC = 'dd-trace-test-topic'

class MqttTestSetup {
  async setup (module) {
    this.mqtt = module

    // Create a client for publishing
    this.publisher = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      this.publisher.on('connect', resolve)
      this.publisher.on('error', reject)
    })

    // Create a client for subscribing (to trigger handlePublish)
    this.subscriber = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      this.subscriber.on('connect', resolve)
      this.subscriber.on('error', reject)
    })

    await new Promise((resolve, reject) => {
      this.subscriber.subscribe(TEST_TOPIC, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async teardown () {
    if (this.publisher) {
      await this.publisher.endAsync()
    }
    if (this.subscriber) {
      await this.subscriber.endAsync()
    }
  }

  // --- Producer operations ---

  async publish () {
    return new Promise((resolve, reject) => {
      this.publisher.publish(TEST_TOPIC, 'test-message', (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async publishError () {
    // Publish to a closed/ended client to trigger an error
    const closedClient = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      closedClient.on('connect', resolve)
      closedClient.on('error', reject)
    })
    await closedClient.endAsync()

    return new Promise((resolve, reject) => {
      closedClient.publish(TEST_TOPIC, 'test-message', (err) => {
        if (err) return reject(err)
        resolve()
      })
    })
  }

  async publishAsync () {
    await this.publisher.publishAsync(TEST_TOPIC, 'test-message-async')
  }

  async publishAsyncError () {
    // Publish to a closed/ended client to trigger an error
    const closedClient = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      closedClient.on('connect', resolve)
      closedClient.on('error', reject)
    })
    await closedClient.endAsync()

    await closedClient.publishAsync(TEST_TOPIC, 'test-message-async')
  }

  // --- Consumer operations ---
  // handlePublish is triggered internally when the subscriber receives a message.
  // We trigger it by publishing a message from the publisher client.

  async handlePublish () {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('handlePublish timeout')), 5000)
      this.subscriber.once('message', () => {
        clearTimeout(timeout)
        resolve()
      })
      this.publisher.publish(TEST_TOPIC, 'test-consumer-message', (err) => {
        if (err) {
          clearTimeout(timeout)
          reject(err)
        }
      })
    })
  }

  async handlePublishError () {
    // Create a dedicated subscriber whose handleMessage produces an error,
    // causing the traced done callback to receive the error.
    const errorSub = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      errorSub.on('connect', resolve)
      errorSub.on('error', reject)
    })
    await new Promise((resolve, reject) => {
      errorSub.subscribe(TEST_TOPIC, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    // Override handleMessage to call its callback with an error.
    // In handlePublish QoS 0 path: client.handleMessage(packet, done)
    // The traced `done` callback captures the error.
    errorSub.handleMessage = function (packet, cb) {
      cb(new Error('simulated handlePublish error'))
    }
    errorSub.on('error', () => {}) // suppress unhandled error events

    await new Promise((resolve, reject) => {
      this.publisher.publish(TEST_TOPIC, 'error-trigger', (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    // Allow time for the message to be processed by the subscriber
    await new Promise(resolve => setTimeout(resolve, 500))
    try { await errorSub.endAsync() } catch {}
  }

  async handlePubrel () {
    // handlePubrel is part of QoS 2 flow.
    // Publish a QoS 2 message to trigger the pubrel handler.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('handlePubrel timeout')), 5000)
      this.subscriber.once('message', () => {
        clearTimeout(timeout)
        resolve()
      })
      this.publisher.publish(TEST_TOPIC, 'test-pubrel-message', { qos: 2 }, (err) => {
        if (err) {
          clearTimeout(timeout)
          reject(err)
        }
      })
    })
  }

  async handlePubrelError () {
    // Create a dedicated subscriber whose handleMessage produces an error.
    // In handlePubrel: client.handleMessage(pub, (err2) => { if (err2) return callback(err2) })
    // The traced `done` (callback) captures the error.
    const errorSub = this.mqtt.connect(BROKER_URL)
    await new Promise((resolve, reject) => {
      errorSub.on('connect', resolve)
      errorSub.on('error', reject)
    })
    await new Promise((resolve, reject) => {
      errorSub.subscribe(TEST_TOPIC, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    errorSub.handleMessage = function (packet, cb) {
      cb(new Error('simulated handlePubrel error'))
    }
    errorSub.on('error', () => {}) // suppress unhandled error events

    // Publish a QoS 2 message to trigger the pubrel flow
    await new Promise((resolve, reject) => {
      this.publisher.publish(TEST_TOPIC, 'error-pubrel', { qos: 2 }, (err) => {
        if (err) return reject(err)
        resolve()
      })
    })

    // Allow time for the QoS 2 handshake and error processing
    await new Promise(resolve => setTimeout(resolve, 2000))
    try { await errorSub.endAsync() } catch {}
  }
}

module.exports = MqttTestSetup
