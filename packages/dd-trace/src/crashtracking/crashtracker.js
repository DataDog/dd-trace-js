'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const binding = libdatadog.load('crashtracker')

const log = require('../log')
const { URL } = require('url')
const pkg = require('../../../../package.json')

class Crashtracker {
  constructor () {
    this._started = false
  }

  configure (config) {
    if (!this._started) return

    try {
      binding.updateConfig(this._getConfig(config))
      binding.updateMetadata(this._getMetadata(config))
    } catch (e) {
      log.error('Error configuring crashtracker', e)
    }
  }

  start (config) {
    if (this._started) return this.configure(config)

    this._started = true

    try {
      binding.init(
        this._getConfig(config),
        this._getReceiverConfig(config),
        this._getMetadata(config)
      )
    } catch (e) {
      log.error('Error initialising crashtracker', e)
    }
  }

  withProfilerSerializing (f) {
    binding.beginProfilerSerializing()
    try {
      return f()
    } finally {
      binding.endProfilerSerializing()
    }
  }

  // TODO: Send only configured values when defaults are fixed.
  _getConfig (config) {
    const { hostname = '127.0.0.1', port = 8126 } = config
    const url = config.url || new URL(`http://${hostname}:${port}`)

    return {
      additional_files: [],
      create_alt_stack: true,
      use_alt_stack: true,
      endpoint: {
        // TODO: Use the string directly when deserialization is fixed.
        url: {
          scheme: url.protocol.slice(0, -1),
          authority: url.protocol === 'unix:'
            ? Buffer.from(url.pathname).toString('hex')
            : url.host,
          path_and_query: ''
        },
        timeout_ms: 3000
      },
      timeout_ms: 5000,
      // TODO: Use `EnabledWithSymbolsInReceiver` instead for Linux when fixed.
      resolve_frames: 'EnabledWithInprocessSymbols'
    }
  }

  _getMetadata (config) {
    const tags = Object.keys(config.tags).map(key => `${key}:${config.tags[key]}`)

    return {
      library_name: pkg.name,
      library_version: pkg.version,
      family: 'nodejs',
      tags: [
        ...tags,
        'is_crash:true',
        'language:javascript',
        `library_version:${pkg.version}`,
        'runtime:nodejs',
        `runtime_version:${process.versions.node}`,
        'severity:crash'
      ]
    }
  }

  _getReceiverConfig () {
    return {
      args: [],
      env: [],
      path_to_receiver_binary: libdatadog.find('crashtracker-receiver', true),
      stderr_filename: null,
      stdout_filename: null
    }
  }
}

module.exports = new Crashtracker()
