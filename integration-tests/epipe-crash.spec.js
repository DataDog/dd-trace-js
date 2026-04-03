'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const http = require('node:http')
const { fork } = require('node:child_process')

const { describe, it, beforeEach, afterEach } = require('mocha')

// Fake agent that sometimes kills connections to simulate an overwhelmed agent.
// The real Datadog agent may close connections under load, causing EPIPE on
// the tracer's keep-alive socket.
function createUnstableAgent () {
  let requestCount = 0
  const server = http.createServer((req, res) => {
    requestCount++
    const chunks = []
    req.on('data', (d) => chunks.push(d))
    req.on('end', () => {
      // Every 3rd request, kill the socket after responding
      // (simulates agent dropping connections under pressure)
      if (requestCount % 3 === 0) {
        res.writeHead(200)
        res.end('{}')
        setTimeout(() => {
          if (!req.socket.destroyed) {
            req.socket.destroy()
          }
        }, 10)
      } else {
        res.writeHead(200)
        res.end('{}')
      }
    })
  })

  return new Promise(resolve => {
    server.listen(0, () => {
      resolve({
        port: server.address().port,
        close: () => server.close(),
      })
    })
  })
}

describe('EPIPE crash reproduction under high span volume', () => {
  let unstableAgent

  beforeEach(async () => {
    unstableAgent = await createUnstableAgent()
  })

  afterEach(() => {
    unstableAgent.close()
  })

  it('should not crash with WS burst traffic against an unstable agent', (done) => {
    const child = fork(
      path.join(__dirname, 'epipe-crash', 'ws-burst-app.js'),
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          DD_TRACE_AGENT_PORT: String(unstableAgent.port),
          DD_TRACE_AGENT_HOSTNAME: 'localhost',
          DD_TRACE_FLUSH_INTERVAL: '100',
        },
      },
    )

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })

    child.on('exit', (code) => {
      if (code !== 0) {
        assert.fail(
          `Process crashed with exit code ${code}.\n` +
          `This reproduces the EPIPE crash from APMS-18805.\n` +
          `stderr (last 2000 chars): ${stderr.slice(-2000)}`,
        )
      }
      assert.ok(stdout.includes('OK'), 'app should complete successfully')
      done()
    })
  }).timeout(15000)

  it('should not crash with WS burst traffic against an agent that drops all connections', (done) => {
    // More aggressive: agent kills EVERY connection
    unstableAgent.close()

    const aggressiveAgent = http.createServer((req, res) => {
      req.on('data', () => {})
      req.on('end', () => {
        req.socket.destroy()
      })
    })

    aggressiveAgent.listen(0, () => {
      const port = aggressiveAgent.address().port

      const child = fork(
        path.join(__dirname, 'epipe-crash', 'ws-burst-app.js'),
        {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: {
            ...process.env,
            DD_TRACE_AGENT_PORT: String(port),
            DD_TRACE_AGENT_HOSTNAME: 'localhost',
            DD_TRACE_FLUSH_INTERVAL: '100',
          },
        },
      )

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (d) => { stdout += d.toString() })
      child.stderr.on('data', (d) => { stderr += d.toString() })

      child.on('exit', (code) => {
        aggressiveAgent.close()
        if (code !== 0) {
          assert.fail(
            `Process crashed with exit code ${code}.\n` +
            `This reproduces the EPIPE crash from APMS-18805.\n` +
            `stderr (last 2000 chars): ${stderr.slice(-2000)}`,
          )
        }
        assert.ok(stdout.includes('OK'), 'app should complete successfully')
        done()
      })
    })
  }).timeout(15000)
})
