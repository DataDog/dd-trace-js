'use strict'

var fs = require('fs')
// Capture the child_process functions at load time, before the tracer wraps the module.
// Reaching through require('child_process') at send time would route the forwarder through
// the tracer's own child_process instrumentation once the tracer is initialized.
var childProcess = require('child_process')
var spawn = childProcess.spawn
// eslint-disable-next-line n/no-unsupported-features/node-builtins
var spawnSync = childProcess.spawnSync
var tracerVersion = require('../../../../package.json').version
var log = require('./log')

module.exports = sendTelemetry

if (!process.env.DD_INJECTION_ENABLED) {
  module.exports = function noop () {}
}

var telemetryForwarderPath = process.env.DD_TELEMETRY_FORWARDER_PATH
if (typeof telemetryForwarderPath !== 'string' || !fs.existsSync(telemetryForwarderPath)) {
  module.exports = function noop () {}
}

var metadata = {
  language_name: 'nodejs',
  language_version: process.versions.node,
  runtime_name: 'nodejs',
  runtime_version: process.versions.node,
  tracer_version: tracerVersion,
  pid: process.pid,
  result: 'unknown',
  result_reason: 'unknown',
  result_class: 'unknown'
}

var seen = {}
function shouldSend (point) {
  if (point.name === 'abort') {
    // This one can only be sent once, regardless of tags
    if (seen.abort) {
      return false
    }
    seen.abort = true
  } else if (point.name === 'abort.integration') {
    // For now, this is the only other one we want to dedupe
    var compiledPoint = point.name + point.tags.join('')
    if (seen[compiledPoint]) {
      return false
    }
    seen[compiledPoint] = true
  }
  return true
}

function sendTelemetry (name, tags, resultMetadata, synchronous) {
  var points = name
  if (typeof name === 'string') {
    points = [{ name: name, tags: tags || [] }]
  }
  if (['1', 'true', 'True'].indexOf(process.env.DD_INJECT_FORCE) !== -1) {
    points = points.filter(function (p) { return ['error', 'complete'].indexOf(p.name) !== -1 })
  }
  points = points.filter(function (p) { return shouldSend(p) })
  for (var i = 0; i < points.length; i++) {
    points[i].name = 'library_entrypoint.' + points[i].name
  }
  if (points.length === 0) {
    return
  }

  // Update metadata with provided result metadata
  var currentMetadata = {}
  for (var key in metadata) {
    currentMetadata[key] = metadata[key]
  }
  if (resultMetadata) {
    for (var resultKey in resultMetadata) {
      currentMetadata[resultKey] = resultMetadata[resultKey]
    }
  }

  var payload = JSON.stringify({ metadata: currentMetadata, points: points })

  // A forwarder spawned asynchronously can still be tearing down its stdio pipes when the
  // injected app calls process.exit(); on Node 24.0.0/24.1.x that deadlocks the exit
  // (fixed upstream in 24.2), hanging short-lived single-step-install processes. On the
  // bailout path the caller passes synchronous=true, so the child is fully reaped before we
  // return and nothing survives to race the exit. spawnSync is only reached on that path,
  // before any instrumentation is active, so it never traces the forwarder. It exists since
  // Node 0.11.12; the guardrails still target >=0.8, which predates the exit bug anyway.
  if (synchronous && spawnSync) {
    var result = spawnSync(telemetryForwarderPath, ['library_entrypoint'], {
      input: payload,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    if (result.error) {
      log.error('Failed to spawn telemetry forwarder')
    } else if (result.status) {
      log.error('Telemetry forwarder exited with code', result.status)
    }
    return
  }

  var proc = spawn(telemetryForwarderPath, ['library_entrypoint'], {
    stdio: 'pipe'
  })
  proc.on('error', function () {
    log.error('Failed to spawn telemetry forwarder')
  })
  proc.once('exit', function (code) {
    if (code !== 0) {
      log.error('Telemetry forwarder exited with code', code)
    }
  })
  proc.stdin.on('error', function () {
    log.error('Failed to write telemetry data to telemetry forwarder')
  })
  proc.stdin.end(payload)
}
