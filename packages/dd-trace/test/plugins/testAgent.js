const http = require('http')
const sinon = require('sinon')
const writer = require('../../src/exporters/agent/writer.js')
const tracingPlugin = require('../../src/plugins/tracing.js')

global.testAgent = {
  expectedServiceName: null,
  schemaVersionName: null,
  sessionToken: null,
  useTestAgent: false,
  stubs: {
    originalMethods: {},
    stubbedMethods: {}
  }
}

// create stub on the writer class method to update headers at time of trace in order to send important
// tracer configurations to APM Test Agent
const sendPayloadMock = function (data, count, done) {
  const thisValue = global.testAgent.stubs.stubbedMethods._sendPayload.lastCall.thisValue
  if (global.testAgent.useTestAgent) {
    // Update the headers with additional values
    const headers = global.testAgent.stubs.stubbedMethods._sendPayload.lastCall.thisValue._headers
    addEnvironmentVariablesToHeaders(headers).then(async (reqHeaders) => {
      global.testAgent.stubs.stubbedMethods._sendPayload.lastCall.thisValue._headers = reqHeaders
      // call original method
      global.testAgent.stubs.originalMethods._sendPayload.call(thisValue, data, count, done)
    })
  } else {
    global.testAgent.stubs.originalMethods._sendPayload.call(thisValue, data, count, done)
  }
}

// create stub on the startSpan method to inject schema version and other tags
const startSpanMock = function (name, { childOf, kind, meta, metrics, service, resource, type } = {}, enter = true) {
  if (global.testAgent.useTestAgent) {
    try {
      meta = meta ?? {}
      meta['_schema_version'] = global.testAgent.schemaVersionName ?? 'v0'
      if (typeof global.testAgent.expectedServiceName === 'string') {
        meta['_expected_service_name'] = global.testAgent.expectedServiceName
      } else if (typeof global.testAgent.expectedServiceName === 'function') {
        meta['_expected_service_name'] = global.testAgent.expectedServiceName()
      }
      if (global.testAgent.sessionToken) {
        meta['_session_token'] = global.testAgent.sessionToken
      }
    } catch (e) {
      // do something
    }
  }
  const thisValue = global.testAgent.stubs.stubbedMethods.startSpan.lastCall.thisValue
  return global.testAgent.stubs.originalMethods.startSpan.call(
    thisValue, name, { childOf, kind, meta, metrics, service, resource, type }, enter
  )
}

function stubStartSpan (stubs) {
  stubs.originalMethods.startSpan = tracingPlugin.prototype.startSpan
  stubs.stubbedMethods.startSpan = sinon.stub(tracingPlugin.prototype, 'startSpan')
    .callsFake((name, { childOf, kind, meta, metrics, service, resource, type }, enter) => {
      return startSpanMock(name, { childOf, kind, meta, metrics, service, resource, type }, enter)
    })
}

function stubSendPayload (stubs) {
  stubs.originalMethods._sendPayload = writer.prototype._sendPayload
  stubs.stubbedMethods._sendPayload = sinon.stub(writer.prototype, '_sendPayload').callsFake((data, count, any) => {
    sendPayloadMock(data, count, any)
  })
}

function unstubMethods (stubs) {
  if (stubs.stubbedMethods._sendPayload) {
    stubs.stubbedMethods._sendPayload.restore()
    stubs.stubbedMethods.startSpan.restore()
    delete stubs.stubbedMethods['_sendPayload']
    delete stubs.stubbedMethods['startSpan']
  }
}

function addEnvironmentVariablesToHeaders (headers) {
  return new Promise((resolve, reject) => {
    // get all environment variables that start with 'DD_'
    headers = headers ?? {}
    delete headers['X-Datadog-Trace-Env-Variables']
    const ddEnvVars = new Map(
      Object.entries(process.env).filter(([key]) => key.startsWith('DD_'))
    )

    // serialize the DD environment variables into a string of k=v pairs separated by comma
    const serializedEnvVars = Array.from(ddEnvVars.entries())
      .map(([key, value]) => `${key}=${value}`).join(',')

    // add the serialized DD environment variables to the header
    // to send with trace to the final agent destination
    if (headers) {
      headers['X-Datadog-Trace-Env-Variables'] = serializedEnvVars
      resolve(headers)
    }
  })
}

// check if APM Test Agent is running
function checkAgentStatus () {
  const agentUrl = process.env.DD_TRACE_AGENT_URL || 'http://127.0.0.1:9126'

  return new Promise((resolve, reject) => {
    const request = http.request(`${agentUrl}/info`, { method: 'GET' }, response => {
      if (response.statusCode === 200) {
        resolve(true)
      } else {
        resolve(false)
      }
    })

    request.on('error', error => {
      reject(error)
    })

    request.end()
  })
}

module.exports = {
  stubStartSpan,
  stubSendPayload,
  unstubMethods,
  checkAgentStatus
}
