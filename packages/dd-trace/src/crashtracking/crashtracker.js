'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const binding = libdatadog.load('crashtracker')

const log = require('../log')
const { getAgentUrl } = require('../agent/url')
const pkg = require('../../../../package.json')
const processTags = require('../process-tags')

class Crashtracker {
  #started = false

  configure (config) {
    if (!this.#started) return

    try {
      binding.updateConfig(this.#getConfig(config))
      binding.updateMetadata(this.#getMetadata(config))
    } catch (e) {
      log.error('Error configuring crashtracker', e)
    }
  }

  start (config) {
    if (this.#started) return this.configure(config)

    this.#started = true

    try {
      binding.init(
        this.#getConfig(config),
        this.#getReceiverConfig(),
        this.#getMetadata(config)
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
  #getConfig (config) {
    const url = getAgentUrl(config)

    // Out-of-process symbolication currently (crashtracker 27.0.0) works on
    // Linux only, does not work on Mac.
    const resolveMode = require('os').platform === 'linux'
      ? 'EnabledWithSymbolsInReceiver'
      : 'EnabledWithInprocessSymbols'

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
          path_and_query: '',
        },
        timeout_ms: 3000,
      },
      timeout: { secs: 5, nanos: 0 },
      demangle_names: false,
      signals: [],
      resolve_frames: resolveMode,
    }
  }

  #getMetadata (config) {
    const tags = Object.keys(config.tags).map(key => `${key}:${config.tags[key]}`)

    // Add process tags to the tags array
    for (const [key, value] of processTags.tags) {
      if (value !== undefined) {
        tags.push(`${key}:${value}`)
      }
    }

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
        'severity:crash',
      ],
    }
  }

  #getReceiverConfig () {
    return {
      args: [],
      env: [],
      path_to_receiver_binary: libdatadog.find('crashtracker-receiver', true),
      stderr_filename: null,
      stdout_filename: null,
    }
  }
}

module.exports = new Crashtracker()
