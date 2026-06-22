'use strict'

const http = require('node:http')

/**
 * Start an in-process NDJSON log intake server.
 * Returns a handle with the assigned port, collected records, and control methods.
 *
 * @param {((record: object) => void) | undefined} [onRecord] Optional callback invoked for every
 *   successfully parsed record. Useful for dev-mode pretty printing without spawning a child process.
 * @param {number} [port] Port to listen on. Defaults to 0 (OS-assigned random port).
 * @returns {Promise<{ port: number, records: object[], reset: () => void, close: () => Promise<void> }>}
 */
function start (onRecord, port = 0) {
  const records = []

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }

    req.on('error', () => {})
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const record = JSON.parse(trimmed)
          records.push(record)
          if (onRecord) onRecord(record)
        } catch (_) {
          // skip malformed lines
        }
      }
      res.writeHead(200)
      res.end('OK')
    })
  })

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        records,
        reset () { records.length = 0 },
        close () {
          return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
        },
      })
    })
    server.once('error', reject)
  })
}

module.exports = { start }

// ── Standalone mode ────────────────────────────────────────────────────────────
// Run directly (`node mock-intake.js`) to start a human-friendly intake server.
// Set INTAKE_PORT env var to override the default port (7777).
if (require.main === module) {
  const PORT = parseInt(process.env.INTAKE_PORT || '7777', 10)

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }

    req.on('error', () => {})
    let body = ''
    req.on('data', chunk => { body += chunk.toString() })
    req.on('end', () => {
      for (const line of body.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const record = JSON.parse(trimmed)
          process.stdout.write('\n--- record ---\n' + JSON.stringify(record, null, 2) + '\n')
        } catch (_) {
          process.stdout.write('(malformed line: ' + trimmed + ')\n')
        }
      }
      res.writeHead(200)
      res.end('OK')
    })
  })

  server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`Mock intake listening on http://127.0.0.1:${PORT}\n`)
    process.stdout.write(`Set DD_LOG_CAPTURE_PORT=${PORT} when starting app.js\n\n`)
  })
}
