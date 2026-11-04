'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

const { describe, it } = require('mocha')

describe('exposure delivery during natural process exit', function () {
  this.timeout(20000)

  for (const applicationMs of [0, 1500]) {
    const title = applicationMs
      ? 'delivers all batches during application work'
      : 'starts shutdown before draining batches'
    it(title,
      async () => {
        const count = applicationMs ? 30 : 80
        const responseMs = applicationMs ? 20 : 100
        let received = 0
        const server = http.createServer((req, res) => {
          req.resume()
          req.on('end', () => {
            received++
            setTimeout(() => res.end('OK'), responseMs)
          })
        })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        try {
          const url = `http://127.0.0.1:${server.address().port}`
          const stdout = await new Promise((resolve, reject) => {
            execFile(process.execPath, [
              path.join(__dirname, 'fixtures/exposure-drain.js'), url, String(count), String(applicationMs),
            ], { timeout: 15000, env: { ...process.env, DD_TRACE_ENABLED: 'false' } }, (error, stdout) => {
              if (error) reject(error)
              else resolve(stdout)
            })
          })
          const result = JSON.parse(stdout.trim())
          assert.strictEqual(received + result.dropped, count)
          if (applicationMs) {
            assert.strictEqual(received, count)
            assert.strictEqual(result.dropped, 0)
            assert.ok(result.beforeExitMs >= applicationMs)
          } else {
            assert.ok(result.beforeExitMs < 3000, JSON.stringify(result))
            assert.ok(result.dropped > 0, JSON.stringify(result))
            assert.ok(received > 0)
          }
        } finally {
          server.closeAllConnections()
          await new Promise(resolve => server.close(resolve))
        }
      })
  }
})
