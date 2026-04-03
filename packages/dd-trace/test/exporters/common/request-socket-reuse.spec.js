'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { describe, it, beforeEach, afterEach } = require('mocha')

const agent = require('../../plugins/agent')

// Test socket reuse with keep-alive when the agent kills idle sockets.
// The tracer uses maxSockets=1 + keepAlive=true, so all requests share
// one socket. If the agent closes the idle socket between flushes,
// the next request hits EPIPE on the stale socket.

describe('request socket reuse with net instrumentation', () => {
  let request

  beforeEach(() => {
    return agent.load(['net', 'dns', 'http']).then(() => {
      delete require.cache[require.resolve('../../../src/exporters/common/request')]
      request = require('../../../src/exporters/common/request')
    })
  })

  afterEach(() => {
    return agent.close()
  })

  it('should not crash when keep-alive socket is killed between requests', (done) => {
    // First request succeeds, server then kills the idle socket,
    // second request hits EPIPE/ECONNRESET on the stale keep-alive socket.
    let requestCount = 0
    const server = http.createServer((req, res) => {
      requestCount++
      const chunks = []
      req.on('data', (d) => chunks.push(d))
      req.on('end', () => {
        if (requestCount === 1) {
          // First request: respond normally, then destroy the socket
          // after a tiny delay (simulates agent closing idle connection)
          res.writeHead(200)
          res.end('OK')
          setTimeout(() => {
            req.socket.destroy()
          }, 50)
        } else {
          // Subsequent requests: respond normally
          res.writeHead(200)
          res.end('OK')
        }
      })
    })

    server.listen(0, () => {
      const port = server.address().port

      const uncaughtGuard = (err) => {
        server.close()
        done(new Error(`uncaughtException on stale socket: ${err.code} - ${err.message}`))
      }
      process.once('uncaughtException', uncaughtGuard)

      // First request — succeeds, then server kills the socket
      request(Buffer.from('first'), {
        protocol: 'http:',
        hostname: 'localhost',
        port,
        path: '/v0.4/traces',
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
      }, (err, res) => {
        if (err) {
          process.removeListener('uncaughtException', uncaughtGuard)
          server.close()
          return done(err)
        }

        assert.strictEqual(res, 'OK')

        // Wait for the server to destroy the socket, then send second request
        // which will try to reuse the now-dead keep-alive socket
        setTimeout(() => {
          request(Buffer.from('second-on-stale-socket'), {
            protocol: 'http:',
            hostname: 'localhost',
            port,
            path: '/v0.4/traces',
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
          }, (err2) => {
            process.removeListener('uncaughtException', uncaughtGuard)
            server.close()
            // Error or success — what matters is no crash
            done()
          })
        }, 100)
      })
    })
  }).timeout(10000)

  it('should not crash under repeated flush cycles with intermittent socket death', (done) => {
    // Simulates the real scenario: tracer flushes every N seconds,
    // agent occasionally kills connections under load.
    let requestCount = 0
    const server = http.createServer((req, res) => {
      requestCount++
      const chunks = []
      req.on('data', (d) => chunks.push(d))
      req.on('end', () => {
        // Every 3rd request, kill the socket after responding
        // (simulates overwhelmed agent dropping connections)
        res.writeHead(200)
        res.end('OK')
        if (requestCount % 3 === 0) {
          setTimeout(() => {
            req.socket.destroy()
          }, 10)
        }
      })
    })

    server.listen(0, () => {
      const port = server.address().port
      const totalFlushes = 15
      let completed = 0

      const uncaughtGuard = (err) => {
        server.close()
        done(new Error(`uncaughtException on flush cycle ${completed}: ${err.code} - ${err.message}`))
      }
      process.once('uncaughtException', uncaughtGuard)

      function doFlush (i) {
        if (i >= totalFlushes) {
          process.removeListener('uncaughtException', uncaughtGuard)
          server.close()
          return done()
        }

        request(Buffer.from(`flush-${i}-payload`), {
          protocol: 'http:',
          hostname: 'localhost',
          port,
          path: '/v0.4/traces',
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
        }, () => {
          completed++
          // Stagger flushes to allow socket reuse
          setTimeout(() => doFlush(i + 1), 30)
        })
      }

      doFlush(0)
    })
  }).timeout(15000)
})
