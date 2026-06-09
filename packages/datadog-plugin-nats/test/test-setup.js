'use strict'

const PUBLISH_SUBJECT = 'test.publish'
const CONSUME_SUBJECT = 'test.consume'
const REQUEST_SUBJECT = 'test.request'

class NatsTestSetup {
  async setup (module) {
    this._nats = module
    this._sc = module.StringCodec()
    this._nc = await module.connect({ servers: '127.0.0.1:4222' })
  }

  async teardown () {
    if (this._nc && !this._nc.isClosed()) {
      await this._nc.close()
    }
    this._nc = undefined
  }

  async publish () {
    this._nc.publish(PUBLISH_SUBJECT, this._sc.encode('hello'))
    await this._nc.flush()
  }

  async publishError () {
    // Publishing to an empty subject triggers a BadSubject error
    this._nc.publish('', this._sc.encode('hello'))
    await this._nc.flush()
  }

  async processMsg () {
    const sub = this._nc.subscribe(CONSUME_SUBJECT, { max: 1 })
    this._nc.publish(CONSUME_SUBJECT, this._sc.encode('hello'))
    await this._nc.flush()
    for await (const _msg of sub) {
      // consume the message
    }
  }

  async processMsgError () {
    // Subscribe on a separate connection (the callback throw kills this connection)
    const errorNc = await this._nats.connect({ servers: '127.0.0.1:4222' })
    errorNc.subscribe(CONSUME_SUBJECT, {
      max: 1,
      callback: () => { throw new Error('test consumer error') },
    })
    // Publish from the main connection so flush doesn't hang
    this._nc.publish(CONSUME_SUBJECT, this._sc.encode('hello'))
    await this._nc.flush()
    // Wait for the error connection to process the message and the span to flush
    await new Promise(resolve => setTimeout(resolve, 1000))
    // Clean up the error connection (may already be dead from the throw)
    await Promise.race([
      errorNc.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
  }

  async request () {
    // Set up a responder first
    const sub = this._nc.subscribe(REQUEST_SUBJECT, {
      max: 1,
      callback: (_err, msg) => {
        msg.respond(this._sc.encode('response'))
      },
    })

    await this._nc.request(REQUEST_SUBJECT, this._sc.encode('request'), { timeout: 5000 })
    sub.unsubscribe()
  }

  async requestError () {
    // Request to a subject with no responder - should timeout
    await this._nc.request('test.request.noresponder', this._sc.encode('request'), { timeout: 100 })
  }
}

module.exports = NatsTestSetup
