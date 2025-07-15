'use strict'

var fs = require('fs')
var spawn = require('child_process').spawn
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
  pid: process.pid
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

function sendTelemetry (name, tags) {
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
  var proc = spawn(process.env.DD_TELEMETRY_FORWARDER_PATH, ['library_entrypoint'], {
    stdio: 'pipe'
  })
  proc.on('error', function () {
    log.error('Failed to spawn telemetry forwarder')
  })
  proc.on('exit', function (code) {
    if (code !== 0) {
      log.error('Telemetry forwarder exited with code', code)
    }
  })
  proc.stdin.on('error', function () {
    log.error('Failed to write telemetry data to telemetry forwarder')
  })
  proc.stdin.end(JSON.stringify({ metadata: metadata, points: points }))
}
