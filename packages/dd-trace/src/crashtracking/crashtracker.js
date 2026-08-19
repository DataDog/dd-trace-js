'use strict'

const { EOL, platform } = require('node:os')

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const binding = libdatadog.load('crashtracker')

const log = require('../log')
const pkg = require('../../../../package.json')
const processTags = require('../process-tags')

const TELEMETRY_INTAKE_SUBDOMAIN = 'instrumentation-telemetry-intake'

/**
 * Builds the minimal receiver environment libdatadog needs to select its two direct crash
 * destinations independently: instrumentation telemetry and Errors Tracking intake.
 *
 * @param {import('../config/config-base')} config - Tracer configuration
 * @returns {Array<[string, string]>}
 */
function getAgentlessReceiverEnvironment (config) {
  if (!config.DD_API_KEY) {
    throw new Error('DD_API_KEY is required for agentless crash tracking')
  }

  const site = config.site.toLowerCase()
  const telemetryHostname = `${TELEMETRY_INTAKE_SUBDOMAIN}.${site}`
  const telemetryUrl = new URL(`https://${telemetryHostname}`)
  if (telemetryUrl.hostname !== telemetryHostname || telemetryUrl.origin !== `https://${telemetryHostname}`) {
    throw new Error(`Invalid DD_SITE for agentless crash tracking: ${config.site}`)
  }

  // libdatadog's telemetry config currently derives its host from DD_TRACE_AGENT_URL even in direct
  // mode. This override is scoped to the crash receiver; Errors Tracking still derives its own host
  // from DD_SITE.
  return [
    ['_DD_DIRECT_SUBMISSION_ENABLED', 'true'],
    ['DD_API_KEY', config.DD_API_KEY],
    ['DD_SITE', site],
    ['DD_TRACE_AGENT_URL', telemetryUrl.origin],
  ]
}

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

  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  start (config) {
    if (this.#started) return this.configure(config)

    try {
      binding.init(
        this.#getConfig(config),
        this.#getReceiverConfig(config),
        this.#getMetadata(config)
      )
      this.#started = true
      this.#trackUnhandledExceptions()
    } catch (e) {
      log.error('Error initializing crashtracker', e)
    }
  }

  #trackUnhandledExceptions () {
    process.once('uncaughtExceptionMonitor', (error, origin) => {
      try {
        binding.reportUncaughtExceptionMonitor(error, origin)
      } catch (e) {
        process.stderr.write(`Error reporting uncaught exception to crashtracker: ${e.toString()}${EOL}`)
      }
    })
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
  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   */
  #getConfig (config) {
    let endpoint = null
    if (!config.DD_AGENTLESS_ENABLED) {
      const url = config.url
      endpoint = {
        // TODO: Use the string directly when deserialization is fixed.
        url: {
          scheme: url.protocol.slice(0, -1),
          authority: url.protocol === 'unix:'
            ? Buffer.from(url.pathname).toString('hex')
            : url.host,
          path_and_query: '',
        },
        timeout_ms: 3000,
      }
    }

    // Out-of-process symbolication currently works on
    // Linux only, does not work on Mac.
    const resolveMode = platform() === 'linux'
      ? 'EnabledWithSymbolsInReceiver'
      : 'EnabledWithInprocessSymbols'

    return {
      additional_files: [],
      collect_all_threads: true,
      create_alt_stack: true,
      use_alt_stack: true,
      endpoint,
      timeout: { secs: 5, nanos: 0 },
      demangle_names: true,
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

  /**
   * @param {import('../config/config-base')} config - Tracer configuration
   * @returns {{
   *   args: string[],
   *   env: Array<[string, string]>,
   *   path_to_receiver_binary: string,
   *   stderr_filename: null,
   *   stdout_filename: null
   * }}
   */
  #getReceiverConfig (config) {
    return {
      args: [],
      env: config.DD_AGENTLESS_ENABLED ? getAgentlessReceiverEnvironment(config) : [],
      path_to_receiver_binary: libdatadog.find('crashtracker-receiver', true),
      stderr_filename: null,
      stdout_filename: null,
    }
  }
}

module.exports = new Crashtracker()
