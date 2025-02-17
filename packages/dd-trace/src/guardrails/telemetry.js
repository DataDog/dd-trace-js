'use strict'

/* eslint-disable no-var */
/* eslint-disable object-shorthand */

var fs = require('node:fs')
var spawn = require('node:child_process').spawn
var tracerVersion = require('../../../../package.json').version
var log = require('./log')

module.exports = sendTelemetry

if (!process.env.DD_INJECTION_ENABLED) {
  module.exports = function () {}
}

if (!process.env.DD_TELEMETRY_FORWARDER_PATH) {
  module.exports = function () {}
}

if (!fs.existsSync(process.env.DD_TELEMETRY_FORWARDER_PATH)) {
  module.exports = function () {}
}

var metadata = {
  language_name: 'nodejs',
  language_version: process.versions.node,
  runtime_name: 'nodejs',
  runtime_version: process.versions.node,
  tracer_version: tracerVersion,
  pid: process.pid
}

var seen = new Set([])
function hasSeen (point) {
  if (point.name === 'abort') {
    // This one can only be sent once, regardless of tags
    return seen.has('abort')
  }
  if (point.name === 'abort.integration') {
    // For now, this is the only other one we want to dedupe
    var compiledPoint = point.name + point.tags.join('')
    return seen.has(compiledPoint)
  }
  return false
}

function sendTelemetry (name, tags) {
  var points = name
  if (typeof name === 'string') {
    points = [{ name: name, tags: tags || [] }]
  }
  if (['1', 'true', 'True'].includes(process.env.DD_INJECT_FORCE)) {
    points = points.filter(function (p) { return ['error', 'complete'].includes(p.name) })
  }
  points = points.filter(function (p) { return !hasSeen(p) })
  for (const point of points) {
    point.name = 'library_entrypoint.' + point.name
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
      log.error('Telemetry forwarder exited with code ' + code)
    }
  })
  proc.stdin.on('error', function () {
    log.error('Failed to write telemetry data to telemetry forwarder')
  })
  proc.stdin.end(JSON.stringify({ metadata: metadata, points: points }))
}
