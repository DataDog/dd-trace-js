'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const { channel } = require('dc-polyfill')

describe('packages/datadog-instrumentations/src/fetch.js', () => {
  describe('globalThis.fetch identity', () => {
    let nameBefore

    before(() => {
      nameBefore = globalThis.fetch.name
      require('../src/fetch')
    })

    it('preserves the fetch function name after dd-trace loads', () => {
      assert.equal(nameBefore, 'fetch')
      assert.equal(globalThis.fetch.name, 'fetch')
    })

    it('forwards calls to the wrapped fetch without recursion', () => {
      return assert.rejects(globalThis.fetch('not-a-real-protocol://x'), TypeError)
    })
  })

  describe('start channel', () => {
    const startChannel = channel('tracing:apm:fetch:request:start')
    let server
    let url
    let receivedRequests
    let abortReason
    let subscriber

    before(done => {
      require('../src/fetch')

      server = http.createServer((req, res) => {
        receivedRequests.push(`${req.method} x-policy=${req.headers['x-policy']}`)
        req.resume()
        res.end('ok')
      })
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/`
        done()
      })
    })

    beforeEach(() => {
      receivedRequests = []
      abortReason = new Error('aborted by a subscriber')
    })

    afterEach(() => {
      startChannel.unsubscribe(subscriber)
    })

    after(done => {
      server.closeAllConnections()
      server.close(done)
    })

    function abortOnStart (ctx) {
      ctx.abortController?.abort(abortReason)
    }

    function cancellableBody () {
      let onCancel
      const cancelled = new Promise(resolve => { onCancel = resolve })
      const body = new ReadableStream({
        pull (controller) {
          controller.enqueue(new TextEncoder().encode('chunk'))
        },
        cancel: onCancel,
      })

      return { body, cancelled }
    }

    it('rejects with the abort reason without sending the request', async () => {
      subscriber = abortOnStart
      startChannel.subscribe(subscriber)

      await assert.rejects(globalThis.fetch(url), error => error === abortReason)
      assert.deepStrictEqual(receivedRequests, [])
    })

    it('rejects a Request input with the abort reason without sending it', async () => {
      subscriber = abortOnStart
      startChannel.subscribe(subscriber)

      await assert.rejects(globalThis.fetch(new Request(url, { method: 'POST', body: 'data' })), error => {
        return error === abortReason
      })
      assert.deepStrictEqual(receivedRequests, [])
    })

    it('rejects with the abort reason even when fetch would reject the options of a Request', async () => {
      subscriber = abortOnStart
      startChannel.subscribe(subscriber)

      await assert.rejects(
        globalThis.fetch(new Request(url), { method: 'GET', body: 'payload' }),
        error => error === abortReason
      )
      assert.deepStrictEqual(receivedRequests, [])
    })

    it('rejects with the abort reason even when fetch would reject a used Request', async () => {
      subscriber = abortOnStart
      startChannel.subscribe(subscriber)
      const request = new Request(url, { method: 'POST', body: 'data' })
      await request.text()

      await assert.rejects(globalThis.fetch(request), error => error === abortReason)
      assert.deepStrictEqual(receivedRequests, [])
    })

    const streamBodyCalls = {
      'a URL with a body in the options': body => globalThis.fetch(url, { method: 'POST', body, duplex: 'half' }),
      'a Request with a body': body => globalThis.fetch(new Request(url, { method: 'POST', body, duplex: 'half' })),
      'a Request with a body in the options': body => {
        return globalThis.fetch(new Request(url, { method: 'POST' }), { body, duplex: 'half' })
      },
      'a Request with a body and options': body => {
        return globalThis.fetch(new Request(url, { method: 'POST', body, duplex: 'half' }), { headers: { a: 'b' } })
      },
    }

    for (const [name, call] of Object.entries(streamBodyCalls)) {
      it(`cancels the stream body of ${name} with the abort reason`, async () => {
        subscriber = abortOnStart
        startChannel.subscribe(subscriber)
        const { body, cancelled } = cancellableBody()

        await assert.rejects(call(body), error => error === abortReason)

        assert.strictEqual(await cancelled, abortReason)
        assert.deepStrictEqual(receivedRequests, [])
      })
    }

    it('sends the request when a subscriber does not abort it', async () => {
      subscriber = () => {}
      startChannel.subscribe(subscriber)

      const response = await globalThis.fetch(url)

      assert.strictEqual(await response.text(), 'ok')
      assert.deepStrictEqual(receivedRequests, ['GET x-policy=undefined'])
    })

    it('publishes a Request input as given and leaves its options to fetch', async () => {
      /** @type {{ req: Request } | undefined} */
      let startContext
      subscriber = ctx => { startContext = ctx }
      startChannel.subscribe(subscriber)
      const request = new Request(url, { headers: { 'x-policy': 'safe' } })
      const init = { method: 'PUT', headers: { 'x-policy': 'dangerous' } }

      const response = await globalThis.fetch(request, init)
      await response.text()

      assert.ok(startContext)
      assert.strictEqual(startContext.req, request)
      assert.deepStrictEqual(receivedRequests, ['PUT x-policy=dangerous'])
    })

    it('publishes a URL input as the request that fetch sends', async () => {
      /** @type {{ req: Request } | undefined} */
      let startContext
      subscriber = ctx => { startContext = ctx }
      startChannel.subscribe(subscriber)

      const response = await globalThis.fetch(url, { method: 'PUT', headers: { 'x-policy': 'dangerous' } })
      await response.text()

      assert.ok(startContext)
      assert.strictEqual(startContext.req.method, 'PUT')
      assert.strictEqual(startContext.req.headers.get('x-policy'), 'dangerous')
      assert.deepStrictEqual(receivedRequests, ['PUT x-policy=dangerous'])
    })
  })
})
