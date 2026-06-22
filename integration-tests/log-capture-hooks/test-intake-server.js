'use strict'

/* eslint-disable no-console */

/**
 * Simple NDJSON intake server for log capture hook integration tests.
 *
 * Receives POST requests with an NDJSON body (one JSON object per line).
 * Prints each record with key fields for visual verification.
 *
 * Usage:
 *   node integration-tests/log-capture-hooks/test-intake-server.js
 */

const http = require('node:http')

/** @type {number} */
let totalReceived = 0

const server = http.createServer((req, res) => {
  // GET /stats — return current record count as JSON (used by run-capture-tests.sh)
  if (req.method === 'GET' && req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ received: totalReceived }))
    return
  }

  // POST /reset — clear the counter between tests (used by run-capture-tests.sh)
  if (req.method === 'POST' && req.url === '/reset') {
    totalReceived = 0
    res.writeHead(200)
    res.end('OK')
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end('Not Found')
    return
  }

  let body = ''
  req.on('data', chunk => { body += chunk.toString() })
  req.on('end', () => {
    const lines = body.split('\n').filter(l => l.trim())
    totalReceived += lines.length

    console.log('\n=== Received %d records (total: %d) ===', lines.length, totalReceived)

    for (let i = 0; i < lines.length; i++) {
      let record
      try {
        record = JSON.parse(lines[i])
      } catch (err) {
        console.error('  [%d] Failed to parse JSON: %s', i + 1, lines[i])
        continue
      }

      console.log('\n--- Record %d ---', i + 1)

      // Timestamp — Bunyan/Pino use numeric `time`, others may use ISO string
      if (record.time !== undefined) {
        const ts = typeof record.time === 'number' ? new Date(record.time).toISOString() : record.time
        console.log('  time:     %s', ts)
      }

      // Level — Pino uses numeric levels, Bunyan too, Winston uses strings
      if (record.level !== undefined) console.log('  level:    %s', record.level)

      // Message field — Winston: `message`, Pino/Bunyan: `msg`
      const msg = record.message !== undefined ? record.message : record.msg
      if (msg !== undefined) console.log('  msg:      %s', msg)

      // pid / hostname — present in Pino and Bunyan, missing in Winston
      if (record.pid !== undefined) console.log('  pid:      %s', record.pid)
      if (record.hostname !== undefined) console.log('  hostname: %s', record.hostname)

      // Datadog trace correlation (injected under `dd`)
      if (record.dd) {
        console.log('  dd.trace_id: %s', record.dd.trace_id || '(none)')
        console.log('  dd.span_id:  %s', record.dd.span_id || '(none)')
        console.log('  dd.service:  %s', record.dd.service || '(none)')
        console.log('  dd.env:      %s', record.dd.env || '(none)')
        console.log('  dd.version:  %s', record.dd.version || '(none)')
      } else {
        console.log('  dd: (missing — trace injection not active)')
      }

      // Any extra user-supplied fields
      const knownFields = new Set(['time', 'level', 'msg', 'message', 'pid', 'hostname', 'name', 'v', 'dd'])
      const extra = Object.keys(record).filter(k => !knownFields.has(k))
      if (extra.length > 0) {
        console.log('  extra: %s', JSON.stringify(Object.fromEntries(extra.map(k => [k, record[k]]))))
      }
    }

    console.log('\n' + '='.repeat(40))
    res.writeHead(200)
    res.end('OK')
  })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Error: port 19876 is already in use.')
    console.error('Kill the existing process with: kill $(lsof -ti :19876)')
  } else {
    console.error('Server error:', err.message)
  }
  process.exit(1)
})

server.listen(19876, () => {
  console.log('Log capture intake server listening on http://localhost:19876')
  console.log('Waiting for NDJSON log records...\n')
})

function shutdown () {
  server.close(() => process.exit(0))
}

process.on('SIGINT', () => {
  console.log('\nTotal records received: %d', totalReceived)
  console.log('Shutting down...')
  shutdown()
})

process.on('SIGTERM', shutdown)
