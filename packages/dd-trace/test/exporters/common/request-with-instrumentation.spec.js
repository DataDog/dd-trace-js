'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it, beforeEach, afterEach } = require('mocha')

const agent = require('../../plugins/agent')

// Test the request module with dd-trace net instrumentation active.
// The customer crash shows Socket.emit in net.js:65 — we need to verify
// that the request module still handles socket errors correctly when
// the net instrumentation wraps Socket.emit.

describe('request with net instrumentation active', () => {
  let request

  beforeEach(() => {
    return agent.load(['net', 'dns', 'http']).then(() => {
      // Load request after instrumentation is active
      delete require.cache[require.resolve('../../../src/exporters/common/request')]
      request = require('../../../src/exporters/common/request')
    })
  })

  afterEach(() => {
    return agent.close()
  })

  function initAbortingHTTPServer () {
    return new Promise(resolve => {
      const server = http.createServer((req, res) => {
        req.on('data', () => {})
        req.on('end', () => {
          req.socket.destroy()
        })
      })
      server.listen(0, () => {
        const port = server.address().port
        resolve({ port, close: () => server.close() })
      })
    })
  }

  it('should not crash when agent destroys socket (with net instrumentation wrapping Socket.emit)', (done) => {
    initAbortingHTTPServer().then(({ port, close }) => {
      const uncaughtGuard = (err) => {
        close()
        done(new Error(`uncaughtException fired through wrapped Socket.emit: ${err.code} - ${err.message}`))
      }
      process.once('uncaughtException', uncaughtGuard)

      request(Buffer.from('test payload'), {
        protocol: 'http:',
        hostname: 'localhost',
        port,
        path: '/v0.4/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, (err) => {
        process.removeListener('uncaughtException', uncaughtGuard)
        close()
        assert.ok(err || true, 'callback should be invoked')
        done()
      })
    })
  }).timeout(10000)

  it('should not crash under rapid flush with net instrumentation when agent keeps closing', (done) => {
    initAbortingHTTPServer().then(({ port, close }) => {
      const uncaughtGuard = (err) => {
        close()
        done(new Error(`uncaughtException fired through wrapped Socket.emit: ${err.code} - ${err.message}`))
      }
      process.once('uncaughtException', uncaughtGuard)

      let completed = 0
      const total = 20

      for (let i = 0; i < total; i++) {
        request(Buffer.from(`payload-${i}`), {
          protocol: 'http:',
          hostname: 'localhost',
          port,
          path: '/v0.4/traces',
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
          },
        }, () => {
          completed++
          if (completed === total) {
            process.removeListener('uncaughtException', uncaughtGuard)
            close()
            done()
          }
        })
      }
    })
  }).timeout(10000)

  it('should not crash with large payload flush when agent socket dies (simulates WS span burst)', (done) => {
    initAbortingHTTPServer().then(({ port, close }) => {
      const uncaughtGuard = (err) => {
        close()
        done(new Error(`uncaughtException fired through wrapped Socket.emit: ${err.code} - ${err.message}`))
      }
      process.once('uncaughtException', uncaughtGuard)

      const largePayload = Buffer.alloc(256 * 1024, 'x')

      request(largePayload, {
        protocol: 'http:',
        hostname: 'localhost',
        port,
        path: '/v0.4/traces',
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      }, (err) => {
        process.removeListener('uncaughtException', uncaughtGuard)
        close()
        assert.ok(err || true, 'callback should be invoked')
        done()
      })
    })
  }).timeout(10000)
})
