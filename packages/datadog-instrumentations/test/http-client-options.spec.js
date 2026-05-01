'use strict'

const assert = require('node:assert/strict')

const { describe, it, before, after } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

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
})
