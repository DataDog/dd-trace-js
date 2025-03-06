'use strict'

// Required test setup
require('../setup/tap')

const proxyquire = require('proxyquire').noPreserveCache()
const http = require('http')
const sinon = require('sinon')

// Only keep what we need
let telemetry
let traceAgent
let clock

const HEARTBEAT_INTERVAL = 43200000
const pluginsByName = {} // if needed by your test

describe('Telemetry extended heartbeat - minimal test', () => {
  before(done => {
    // Spin up a local HTTP server so telemetry has somewhere to "send" data.
    traceAgent = http.createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      // We won't do anything with the requests here,
      // but you could store them if you need to inspect in the test.
      res.end()
    }).listen(0, done)
  })

  after(() => {
    // Clean up
    telemetry.stop()
    traceAgent.close()
  })

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  // The single test we care about:
  it('be sent with up-to-date configuration values', (done) => {
    let configuration

    // Set up a custom "sendData" so we can capture the payload
    const sendDataRequest = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        if (reqType === 'app-extended-heartbeat') {
          configuration = payload.configuration
        }
      }
    }

    // Proxyquire telemetry so we can intercept sendData
    telemetry = proxyquire('../../src/telemetry/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': sendDataRequest
    })

    // Minimal config
    const config = {
      telemetry: { enabled: true, heartbeatInterval: HEARTBEAT_INTERVAL },
      hostname: 'localhost',
      port: traceAgent.address().port,
      service: 'test service',
      version: '1.2.3-beta4',
      appsec: { enabled: true },
      profiling: { enabled: true },
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      }
    }

    // Start telemetry
    telemetry.start(config, { _pluginsByName: pluginsByName })

    // Heartbeat #1
    clock.tick(86400000)
    expect(configuration).to.deep.equal([])

    // First update
    const changes = [
      { name: 'test', value: true, origin: 'code', seq_id: 0 }
    ]
    telemetry.updateConfig(changes, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(changes)

    // Second update
    const updatedChanges = [
      { name: 'test', value: false, origin: 'code', seq_id: 1 }
    ]
    telemetry.updateConfig(updatedChanges, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(updatedChanges)

    // Change needing remap
    const changeNeedingNameRemapping = [
      { name: 'sampleRate', value: 0, origin: 'code', seq_id: 2 }
    ]
    const expectedConfigList = [
      updatedChanges[0],
      { ...changeNeedingNameRemapping[0], name: 'DD_TRACE_SAMPLE_RATE' }
    ]
    telemetry.updateConfig(changeNeedingNameRemapping, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(expectedConfigList)

    // Sampler rules
    const samplingRule = [
      {
        name: 'sampler.rules',
        value: [
          { service: '*', sampling_rate: 1 },
          {
            service: 'svc*',
            resource: '*abc',
            name: 'op-??',
            tags: { 'tag-a': 'ta-v*', 'tag-b': 'tb-v?', 'tag-c': 'tc-v' },
            sample_rate: 0.5
          }
        ],
        origin: 'code',
        seq_id: 3
      }
    ]
    const expectedConfigListWithSamplingRules = expectedConfigList.concat([
      {
        name: 'DD_TRACE_SAMPLING_RULES',
        value: '[{"service":"*","sampling_rate":1},{"service":"svc*","resource":"*abc","name":"op-??","tags":{"tag-a":"ta-v*","tag-b":"tb-v?","tag-c":"tc-v"},"sample_rate":0.5}]',
        origin: 'code',
        seq_id: 3
      }
    ])
    telemetry.updateConfig(samplingRule, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(expectedConfigListWithSamplingRules)

    // Chained changes
    let chainedChanges = expectedConfigListWithSamplingRules.concat([
      { name: 'test', value: true, origin: 'env', seq_id: 4 },
      { name: 'test', value: false, origin: 'remote_config', seq_id: 5 }
    ])
    // samplingRule2 includes the sampler.rules item again, plus the new changes
    const samplingRule2 = [
      { name: 'test', value: true, origin: 'env'},
      { name: 'test', value: false, origin: 'remote_config'}
    ]

    // Update config
    telemetry.updateConfig(samplingRule2, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(chainedChanges)

    done()
  })
})

/**
 * All other tests and describes are commented out or removed.
 * This file now ONLY runs the 'be sent with up-to-date configuration values' test.
 */
