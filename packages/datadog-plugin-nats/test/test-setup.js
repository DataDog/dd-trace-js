'use strict'

class NatsTestSetup {
  async setup (module) {
    this.module = module
    this.nc = null
    this.subscription = null
    this.requestResponder = null
    this.sc = module.StringCodec()
    this.nc = await module.connect({
      servers: ['127.0.0.1:4222'],
      timeout: 5000
    })

    // Set up responder BEFORE any tests run to ensure it's outside instrumentation context
    this.requestResponder = this.nc.subscribe('time.request')
    ;(async () => {
      for await (const msg of this.requestResponder) {
        msg.respond(this.sc.encode(JSON.stringify({ time: new Date().toISOString() })))
      }
    })()

    // Send a test message to verify responder is working
    await new Promise(resolve => setTimeout(resolve, 200))
    this.nc.publish('time.request', this.sc.encode('test'))
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  async teardown () {
    try {
      if (this.subscription) {
        this.subscription.unsubscribe()
      }
      if (this.requestResponder) {
        this.requestResponder.unsubscribe()
      }
      if (this.nc) {
        // Add timeout to prevent hanging
        const timeout = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('NATS close timeout')), 3000)
        )
        await Promise.race([
          (async () => {
            await this.nc.drain()
            await this.nc.close()
          })(),
          timeout
        ]).catch(() => {
          // Ignore timeout errors
        })
      }
    } catch (error) {
      // Ignore errors during teardown
    }
  }

  // --- Operations ---
  async natsconnectionimpl_publish () {
    this.nc.publish('test.hello', this.sc.encode('Hello World'))

    // Give time for the message to be sent
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  async natsconnectionimpl_publish_error () {
    // Create a new connection and close it to trigger error
    const tempNc = await this.module.connect({ servers: ['127.0.0.1:4222'] })
    await tempNc.close()
    // Try to publish on closed connection
    tempNc.publish('test.subject', this.sc.encode('test'))
  }

  async protocolhandler_processmsg () {
    const received = []
    const sub = this.nc.subscribe('test.subscribe')

    // Process messages asynchronously
    ;(async () => {
      for await (const msg of sub) {
        const data = this.sc.decode(msg.data)
        received.push(data)
      }
    })()

    // Give subscription time to set up
    await new Promise(resolve => setTimeout(resolve, 200))

    // Publish messages to trigger processMsg
    // Pass headers object so the producer plugin can inject trace context
    const headers = this.module.headers()
    this.nc.publish('test.subscribe', this.sc.encode('Message 1'), { headers })
    this.nc.publish('test.subscribe', this.sc.encode('Message 2'), { headers: this.module.headers() })
    this.nc.publish('test.subscribe', this.sc.encode('Message 3'), { headers: this.module.headers() })

    // Wait for messages to be processed
    await new Promise(resolve => setTimeout(resolve, 500))

    sub.unsubscribe()
  }

  async protocolhandler_processmsg_error () {
    let errorThrown = false
    const sub = this.nc.subscribe('test.error', {
      callback: (err, msg) => {
        if (err) {
          errorThrown = true
          throw err
        }
        // Throw error synchronously in the callback
        errorThrown = true
        throw new Error('Simulated processing error')
      }
    })

    await new Promise(resolve => setTimeout(resolve, 200))

    // Publish message to trigger processMsg which will invoke callback
    try {
      this.nc.publish('test.error', this.sc.encode('Trigger error'))
      // Wait for message to be processed and error to be thrown in callback
      await new Promise(resolve => setTimeout(resolve, 500))
    } catch (callbackError) {
      // Error from callback is expected
    }

    sub.unsubscribe()

    if (!errorThrown) {
      throw new Error('Error was not thrown as expected')
    }
  }

  // DSM-specific test method that ensures fresh connection state
  async dsm_produce_consume () {
    const received = []
    const subject = 'test.dsm'

    // Create a fresh subscription
    const sub = this.nc.subscribe(subject)

    // Process messages asynchronously
    const messagePromise = (async () => {
      for await (const msg of sub) {
        received.push(msg)
        if (received.length >= 3) break
      }
    })()

    // Give subscription time to set up
    await new Promise(resolve => setTimeout(resolve, 200))

    // Publish messages with headers for DSM context propagation
    const headers1 = this.module.headers()
    const headers2 = this.module.headers()
    const headers3 = this.module.headers()
    this.nc.publish(subject, this.sc.encode('DSM Message 1'), { headers: headers1 })
    this.nc.publish(subject, this.sc.encode('DSM Message 2'), { headers: headers2 })
    this.nc.publish(subject, this.sc.encode('DSM Message 3'), { headers: headers3 })

    // Wait for messages to be processed or timeout
    const timeout = new Promise(resolve => setTimeout(resolve, 2000))
    await Promise.race([messagePromise, timeout])

    sub.unsubscribe()
    return { received, subject }
  }

  async natsconnectionimpl_request () {
    // Set up a fresh responder for this test
    const responder = this.nc.subscribe('time.request.fresh')
    ;(async () => {
      for await (const msg of responder) {
        msg.respond(this.sc.encode(JSON.stringify({ time: new Date().toISOString() })))
      }
    })()

    // Wait for responder to start
    await new Promise(resolve => setTimeout(resolve, 200))

    const response = await this.nc.request('time.request.fresh', this.module.Empty, { timeout: 3000 })
    this.sc.decode(response.data)

    responder.unsubscribe()
  }

  async natsconnectionimpl_request_error () {
    // Request to a subject with no responder - should timeout
    await this.nc.request('nonexistent.subject', this.module.Empty, { timeout: 500 })
  }

  // Context propagation test: publish and consume with trace context
  async context_propagation_produce_consume () {
    const received = []
    const subject = 'test.context.propagation'

    // Create a fresh subscription
    const sub = this.nc.subscribe(subject)

    // Process messages asynchronously
    const messagePromise = (async () => {
      for await (const msg of sub) {
        received.push(msg)
        if (received.length >= 1) break
      }
    })()

    // Give subscription time to set up
    await new Promise(resolve => setTimeout(resolve, 200))

    // Publish message with headers for context propagation
    // The tracer will inject trace context into these headers
    const headers = this.module.headers()
    this.nc.publish(subject, this.sc.encode('Context propagation test'), { headers })

    // Wait for messages to be processed or timeout
    const timeout = new Promise(resolve => setTimeout(resolve, 2000))
    await Promise.race([messagePromise, timeout])

    sub.unsubscribe()
    return { received, subject }
  }
}

module.exports = NatsTestSetup
