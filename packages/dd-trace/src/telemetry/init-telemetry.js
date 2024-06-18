'use strict'

const fs = require('fs')
const { spawn } = require('child_process')
const tracerVersion = require('../../../../package.json').version
const log = require('../log')

module.exports = sendTelemetry

if (!process.env.DD_INJECTION_ENABLED) {
  module.exports = () => {}
}

if (!process.env.DD_TELEMETRY_FORWARDER_PATH) {
  module.exports = () => {}
}

if (!fs.existsSync(process.env.DD_TELEMETRY_FORWARDER_PATH)) {
  module.exports = () => {}
}

const metadata = {
  language_name: 'nodejs',
  language_version: process.versions.node,
  runtime_name: 'nodejs',
  runtime_version: process.versions.node,
  tracer_version: tracerVersion,
  pid: process.pid
}

const seen = []
function hasSeen (point) {
  if (point.name === 'abort') {
    // This one can only be sent once, regardless of tags
    return seen.includes('abort')
  }
  if (point.name === 'abort.integration') {
    // For now, this is the only other one we want to dedupe
    const compiledPoint = point.name + point.tags.join('')
    return seen.includes(compiledPoint)
  }
  return false
}

function sendTelemetry (name, tags = []) {
  let points = name
  if (typeof name === 'string') {
    points = [{ name, tags }]
  }
  if (['1', 'true', 'True'].includes(process.env.DD_INJECT_FORCE)) {
    points = points.filter(p => ['error', 'complete'].includes(p.name))
  }
  points = points.filter(p => !hasSeen(p))
  points.forEach(p => {
    p.name = `library_entrypoint.${p.name}`
  })
  if (points.length === 0) {
    return
  }
  const proc = spawn(process.env.DD_TELEMETRY_FORWARDER_PATH, ['library_entrypoint'], {
    stdio: 'pipe'
  })
  proc.on('error', () => {
    log.error('Failed to spawn telemetry forwarder')
  })
  proc.on('exit', (code) => {
    if (code !== 0) {
      log.error(`Telemetry forwarder exited with code ${code}`)
    }
  })
  proc.stdin.on('error', () => {
    log.error('Failed to write telemetry data to telemetry forwarder')
  })
  proc.stdin.end(JSON.stringify({ metadata, points }))
}
