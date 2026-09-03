'use strict'

const libdatadogExtras = require('@datadog/libdatadog-extras')
const proxyquire = require('proxyquire')

const intakeUrl = process.env.DD_TEST_AGENTLESS_TELEMETRY_URL
if (intakeUrl === undefined) throw new Error('DD_TEST_AGENTLESS_TELEMETRY_URL is required')

const binding = libdatadogExtras.load('crashtracker')

const testBinding = {
  ...binding,

  /**
   * @param {object} config
   * @param {{ env: Array<[string, string]> }} receiverConfig
   * @param {object} metadata
   */
  init (config, receiverConfig, metadata) {
    receiverConfig.env.push(['DD_ERRORS_INTAKE_DD_URL', intakeUrl])
    binding.init(config, receiverConfig, metadata)
  },
}

const testLibdatadogExtras = {
  ...libdatadogExtras,

  /**
   * @param {string} name
   * @returns {object}
   */
  load (name) {
    return name === 'crashtracker' ? testBinding : libdatadogExtras.load(name)
  },
}
testLibdatadogExtras['@global'] = true

function getAgentlessTelemetryUrl () {
  return new URL(intakeUrl)
}
getAgentlessTelemetryUrl['@global'] = true

// Initialize through the normal fixture while the global stubs are active. Runtime-global stubs
// bypass the module cache and split tracer singleton state across duplicate module instances.
proxyquire('../signal-crash', {
  '@datadog/libdatadog-extras': testLibdatadogExtras,
  '../../packages/dd-trace/src/telemetry/agentless-url': getAgentlessTelemetryUrl,
})
