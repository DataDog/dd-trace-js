'use strict'

const { EOL, platform } = require('node:os')

// Load binding first to not import other modules if it throws
const libdatadogExtras = require('@datadog/libdatadog-extras')
const binding = libdatadogExtras.load('crashtracker')

const { channel } = require('dc-polyfill')
const { getEnvironmentVariable } = require('../config/helper')
const log = require('../log')
const pkg = require('../../../../package.json')
const processTags = require('../process-tags')
const getAgentlessTelemetryUrl = require('../telemetry/agentless-url')

const identityRefreshChannel = channel('datadog:identity:refresh')
const INHERITED_RECEIVER_ENVIRONMENT_VARIABLES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
]

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
  const defaultTelemetryUrl = getAgentlessTelemetryUrl(site).origin
  // These are libdatadog receiver controls, not tracer configuration.
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const { DD_APM_TELEMETRY_DD_URL, DD_ERRORS_INTAKE_DD_URL } = process.env
  const telemetryUrl = DD_APM_TELEMETRY_DD_URL ?? defaultTelemetryUrl

  const environment = /** @type {Array<[string, string]>} */ ([
    ['_DD_DIRECT_SUBMISSION_ENABLED', 'true'],
    ['DD_API_KEY', config.DD_API_KEY],
    ['DD_SITE', site],
    ['DD_APM_TELEMETRY_DD_URL', telemetryUrl],
    // libdatadog v43 parses the dedicated URL above but does not use it when constructing the
    // endpoint. Keep this compatibility fallback until its telemetry config honors that setting.
    ['DD_TRACE_AGENT_URL', telemetryUrl],
  ])
  if (DD_ERRORS_INTAKE_DD_URL !== undefined) {
    environment.push(['DD_ERRORS_INTAKE_DD_URL', DD_ERRORS_INTAKE_DD_URL])
  }

  // The receiver environment does not inherit from this process.
  for (const name of INHERITED_RECEIVER_ENVIRONMENT_VARIABLES) {
    const value = getEnvironmentVariable(name)
    if (value) environment.push([name, value])
  }

  return environment
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
      identityRefreshChannel.subscribe((config) => this.configure(config))
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
      path_to_receiver_binary: libdatadogExtras.find('crashtracker-receiver', true),
      stderr_filename: null,
      stdout_filename: null,
    }
  }
}

module.exports = new Crashtracker()
