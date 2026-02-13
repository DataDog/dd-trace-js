'use strict'

const http = require('http')

/**
 * Normalize log payload from different logger formats
 * Supports:
 * - Winston RPC format: { method: "log", params: {...} } or [{ method: "log", params: {...} }]
 * - Flat format: [{ level, message, ... }] or { level, message, ... }
 *
 * @param {string} body - Raw request body
 * @returns {Array} Normalized array of log objects
 */
function normalizeLogPayload (body) {
  const parsed = JSON.parse(body)

  // Array format
  if (Array.isArray(parsed)) {
    // Winston batch: [{ method: "log", params: {...} }]
    if (parsed.length > 0 && parsed[0]?.method === 'log') {
      return parsed.map(item => ({
        ...item.params,
        timestamp: item.params.timestamp || Date.now()
      }))
    }
    // Custom format: [{ level, message, ... }]
    return parsed
  }

  // Single object
  if (parsed.method === 'log') {
    // Winston single: { method: "log", params: {...} }
    return [{
      ...parsed.params,
      timestamp: parsed.params.timestamp || Date.now()
    }]
  }

  // Custom single: { level, message, ... }
  return [parsed]
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = ''
    req.on('data', chunk => {
      body += chunk.toString()
    })
    req.on('end', () => {
      try {
        const logs = normalizeLogPayload(body)

        // Detect and log format for debugging
        const parsed = JSON.parse(body)
        let format = 'unknown'
        if (Array.isArray(parsed)) {
          format = parsed[0]?.method === 'log' ? 'winston-rpc-batch' : 'flat-array'
        } else if (parsed.method === 'log') {
          format = 'winston-rpc-single'
        } else {
          format = 'flat-single'
        }

        console.log('\n=== Received %d logs (format: %s) ===', logs.length, format)
        logs.forEach((log, idx) => {
          console.log('\n--- Log %d ---', idx + 1)

          // Handle timestamp - different field names across loggers
          const timestamp = log.timestamp || log.time
          if (timestamp) {
            try {
              console.log('Timestamp:', new Date(timestamp).toISOString())
            } catch {
              console.log('Timestamp:', timestamp, '(raw)')
            }
          }

          console.log('Level:', log.level)
          // Handle message field - Winston uses 'message', Pino/Bunyan use 'msg'
          console.log('Message:', log.message || log.msg)

          // Check for dd object (nested) or dd.* fields (flat)
          if (log.dd) {
            console.log('Trace ID:', log.dd.trace_id)
            console.log('Span ID:', log.dd.span_id)
            console.log('Service:', log.dd.service)
            console.log('Env:', log.dd.env)
            console.log('Version:', log.dd.version)
          } else if (log['dd.trace_id']) {
            console.log('Trace ID:', log['dd.trace_id'])
            console.log('Span ID:', log['dd.span_id'])
            console.log('Service:', log['dd.service'])
            console.log('Env:', log['dd.env'])
            console.log('Version:', log['dd.version'])
          }

          // Show any additional fields
          const standardFields = ['timestamp', 'time', 'level', 'message', 'msg', 'name', 'hostname', 'pid', 'v', 'dd', 'dd.trace_id', 'dd.span_id', 'dd.service', 'dd.env', 'dd.version']
          const customFields = Object.keys(log).filter(k => !standardFields.includes(k) && !k.startsWith('dd.') && k !== 'dd')
          if (customFields.length > 0) {
            console.log('Custom fields:', JSON.stringify(
              customFields.reduce((acc, k) => ({ ...acc, [k]: log[k] }), {}),
              null,
              2
            ))
          }
        })
        console.log('\n======================\n')
        res.writeHead(200)
        res.end('OK')
      } catch (err) {
        console.error('Error parsing logs:', err.message)
        res.writeHead(400)
        res.end('Bad Request')
      }
    })
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

server.listen(8080, () => {
  console.log('Test intake service listening on http://localhost:8080')
  console.log('Waiting for logs...\n')
})

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down intake service...')
  server.close(() => {
    process.exit(0)
  })
})
