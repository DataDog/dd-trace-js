#!/usr/bin/env node
'use strict'

/* eslint-disable no-console */

/**
 * Integration test: Pino records carry dd trace context even when DD_LOGS_INJECTION=false.
 *
 * When logInjection is off, the serialized JSON has no `dd` field.
 * PinoPlugin.handleJsonLine detects this via the `!shouldInject` branch and
 * re-injects trace context from the current active span before forwarding
 * to the capture sender.
 *
 * This exercises the re-enrichment path in PinoPlugin.handleJsonLine:
 *   - shouldInject=false, shouldCapture=true, logHolder present
 *   - The capture branch splices `,"dd":<context>` into the line without
 *     modifying the original payload line that goes to the actual transport.
 *
 * Usage:
 *   node integration-tests/log-capture-hooks/test-log-injection-off.js
 *   (No separate intake server required)
 *
 * Expected outcome:
 *   - EXIT 0: 3 records received, each with dd.trace_id and dd.span_id
 *   - EXIT 1: wrong record count, or dd context absent from any record
 */

process.env.DD_LOG_CAPTURE_ENABLED = 'true'
process.env.DD_LOG_CAPTURE_FLUSH_INTERVAL_MS = '100'
process.env.DD_LOGS_INJECTION = 'false' // key: no injection → PinoPlugin must re-enrich for capture
process.env.DD_TRACE_STARTUP_LOGS = 'false'

const http = require('node:http')

/** @type {object[]} */
const records = []

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    for (const line of body.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch (_) {
        records.push({ _parseError: line })
      }
    }
    res.writeHead(200)
    res.end('OK')
  })
})

server.listen(0, () => {
  // Set capture port BEFORE loading the tracer so the config reads the correct value.
  process.env.DD_LOG_CAPTURE_HOST = 'localhost'
  process.env.DD_LOG_CAPTURE_PORT = String(server.address().port)

  const tracer = require('../../index').init({
    service: 'log-injection-off-test',
    env: 'test',
    version: '1.0.0',
  })

  const pino = require('pino')
  const { version: pinoVersion } = require('pino/package.json')

  const logger = pino({ level: 'info' }, { write: () => {} })

  console.log('\n=== logInjection=false Capture Test (pino v%s) ===', pinoVersion)
  console.log('Re-enrichment: PinoPlugin.handleJsonLine splices dd context into captured line')
  console.log('Inline intake server on port %d\n', server.address().port)

  const EXPECTED = 3

  const span = tracer.startSpan('log.injection.off')
  tracer.scope().activate(span, () => {
    logger.info({ requestId: 'req-abc' }, 'log-injection-off record 1')
    logger.warn({ userId: 42 }, 'log-injection-off record 2')
    logger.info('log-injection-off record 3')
    span.finish()
  })

  setTimeout(() => {
    server.close()

    /** @type {string[]} */
    const failures = []

    if (records.length !== EXPECTED) {
      failures.push(`expected ${EXPECTED} records, got ${records.length}`)
    }

    for (let i = 0; i < records.length; i++) {
      const r = records[i]
      if (r._parseError) {
        failures.push(`record ${i + 1}: JSON parse error — ${r._parseError}`)
        continue
      }
      if (!r.dd) {
        failures.push(`record ${i + 1}: missing dd field (re-enrichment did not run)`)
      } else {
        if (!r.dd.trace_id) failures.push(`record ${i + 1}: dd.trace_id absent`)
        if (!r.dd.span_id) failures.push(`record ${i + 1}: dd.span_id absent`)
        if (!r.dd.service) failures.push(`record ${i + 1}: dd.service absent`)
      }
      if (!r.msg) {
        failures.push(`record ${i + 1}: msg field absent`)
      }
    }

    if (failures.length === 0) {
      console.log('✅ PASS: %d records received, all carry dd.trace_id and dd.span_id\n', records.length)
      for (let i = 0; i < records.length; i++) {
        const r = records[i]
        console.log('  [%d] msg=%s  dd.trace_id=%s  dd.span_id=%s',
          i + 1, r.msg, r.dd.trace_id, r.dd.span_id)
      }
      console.log()
      process.exit(0)
    } else {
      console.error('❌ FAIL:\n  %s\n', failures.join('\n  '))
      if (records.length > 0) {
        console.error('Records received:')
        for (const r of records) console.error('  %j', r)
      }
      process.exit(1)
    }
  }, 400)
})
