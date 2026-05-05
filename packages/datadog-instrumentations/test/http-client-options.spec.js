'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { describe, it, before, after } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

const startChannel = dc.channel('apm:http:client:request:start')

describe('http client option ownership', () => {
  let http
  let server
  let port

  before(async () => {
    await agent.load('http')
    // Require http after `agent.load` so the ritm hook actually wraps
    // `request`/`get` on the module instance the test uses.
    http = require('node:http')

    server = http.createServer((req, res) => res.end()).listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    port = server.address().port
  })

  after(async () => {
    server.close()
    await agent.close()
  })

  it('does not mutate the caller URL when options carry custom keys', (done) => {
    const url = new URL(`http://127.0.0.1:${port}/`)
    const ownProps = Object.getOwnPropertyNames(url)
    const options = { method: 'GET', headers: { 'x-custom': '1' } }

    const req = http.request(url, options, (res) => {
      res.resume()
      res.on('end', () => {
        try {
          assert.deepStrictEqual(Object.getOwnPropertyNames(url), ownProps)
          assert.strictEqual(Object.hasOwn(url, 'headers'), false)
          assert.strictEqual(Object.hasOwn(url, 'method'), false)
          done()
        } catch (error) {
          done(error)
        }
      })
    })
    req.on('error', done)
    req.end()
  })

  it('does not mutate the caller options object when no URL is provided', (done) => {
    const options = {
      protocol: 'http:',
      host: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
    }
    const snapshot = { ...options }

    const req = http.request(options, (res) => {
      res.resume()
      res.on('end', () => {
        try {
          assert.deepStrictEqual(options, snapshot)
          assert.strictEqual(Object.hasOwn(options, 'headers'), false)
          done()
        } catch (error) {
          done(error)
        }
      })
    })
    req.on('error', done)
    req.end()
  })

  // Two inputs cover both legs of the wrapper's invalid-input guard: the
  // `=== null` branch and the `typeof !== 'object'` branch. Spreading either
  // would yield `{}` and silently synthesize a localhost request.
  for (const badInput of [123, null]) {
    it(`falls through to native http.request when first arg is ${String(badInput)}`, () => {
      let synthesizedStart = false
      const onStart = (payload) => {
        if (payload?.args?.originalUrl === badInput) {
          synthesizedStart = true
        }
      }
      startChannel.subscribe(onStart)

      let req
      try {
        try {
          req = http.request(badInput)
        } catch {
          // Native http.request may surface ERR_INVALID_ARG_TYPE on some Node
          // versions; either outcome is acceptable as long as the wrapper did
          // not emit a synthesized start event.
        }
        if (req) {
          req.on('error', () => {})
          req.destroy()
        }
        assert.strictEqual(synthesizedStart, false)
      } finally {
        startChannel.unsubscribe(onStart)
      }
    })
  }
})
