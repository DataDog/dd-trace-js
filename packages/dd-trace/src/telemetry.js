'use strict'

const tracerVersion = require('../lib/version')
const pkg = require('./pkg')
const util = require('util')
const fs = require('fs')
const path = require('path')
const http = require('http')

let config
let instrumenter

const data = {
  seq_id: -1
}

function getIntegrations () {
  return [...new Set(instrumenter._instrumented.keys())].map(plugin => ({
    name: plugin.name,
    enabled: true,
    auto_enabled: true
  }))
}

function recursiveGetDeps (nmDir, results = []) {
  let deps
  try {
    deps = fs.readdirSync(nmDir, 'utf8')
  } catch (e) {
    return results
  }
  for (const dir of deps) {
    const moduleDir = path.join(nmDir, dir)
    if (dir.startsWith('@')) {
      recursiveGetDeps(moduleDir, results)
    } else {
      const pkgPath = path.join(moduleDir, 'package.json')
      try {
        const { name, version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        results.push({ name, version })
      } catch (e) { /* skip */ }
      const newNmDir = path.join(moduleDir, 'node_modules')
      recursiveGetDeps(newNmDir, results)
    }
  }
  return results
}

function getDependencies () {
  const cwd = pkg.findRoot()
  const dirPath = pkg.findUp('node_modules', cwd)
  return recursiveGetDeps(dirPath)
}

function flatten (input, result = {}, prefix = []) {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'object' && value !== null) {
      flatten(value, result, [...prefix, key])
    } else {
      result[[...prefix, key].join('.')] = value
    }
  }
  return result
}

function sendTelemetry () {
  if (!config || !instrumenter) {
    return
  }

  const integrations = getIntegrations()
  if (util.isDeepStrictEqual(integrations, data.integrations)) {
    return
  }

  if (!data.runtime_id) {
    data.runtime_id = config.experimental.runtimeIdValue // TODO
  }

  data.seq_id++

  if (!data.service_name) {
    data.service_name = config.service
  }

  if (!data.env) {
    data.env = config.env
  }

  if (!data.started_at) {
    data.started_at = Math.floor(Date.now() / 1000) - Math.floor(process.uptime()) // seconds since epoch?
  }

  if (!data.tracer_version) {
    data.tracer_version = tracerVersion
  }

  if (!data.language_name) {
    data.language_name = 'node_js'
  }

  data.integrations = integrations

  if (!data.depenencies && pkg.dependencies) {
    const deps = []
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      deps.push({ name, version })
    }
    data.dependencies = getDependencies()
  }

  if (!data.service_version) {
    data.service_version = config.version
  }

  if (!data.language_version) {
    data.language_version = process.versions.node
  }

  if (!data.configuration) {
    data.configuration = flatten(config)
  }

  sendData(data)
}

function sendData (data) {
  const {
    hostname,
    port
  } = config
  const backendHost = 'tracer-telemetry-edge.datadoghq.com'
  const backendUrl = `https://${backendHost}/api/v1/intake/apm-app-env`
  const req = http.request({
    hostname,
    port,
    method: 'POST',
    path: backendUrl,
    headers: {
      host: backendHost,
      'content-type': 'application/json',
      'dd-tracer-timestamp': Math.floor(Date.now() / 1000)
    }
  })
  req.on('error', () => {
    // Ignore errors
  })
  req.write(JSON.stringify(data))
  req.end()
}

function startTelemetry (aConfig, theInstrumenter) {
  config = aConfig
  instrumenter = theInstrumenter
  return setInterval(sendTelemetry, 60 * 1000)
}

module.exports = startTelemetry
