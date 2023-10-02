'use strict'

require('../setup/tap')

const tracerVersion = require('../../../../package.json').version
const proxyquire = require('proxyquire')
const http = require('http')
const { once } = require('events')
const { storage } = require('../../../datadog-core')
const os = require('os')
const { log, assert } = require('console')
const { expect } = require('chai')
const sinon = require('sinon')

const DEFAULT_HEARTBEAT_INTERVAL = 60000

let traceAgent

describe('telemetry', () => {
  const HEARTBEAT_INTERVAL = 60000
  let origSetInterval
  let telemetry
  let pluginsByName

  before(done => {
    origSetInterval = setInterval

    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(1000 * 60 * 60 * 24)
      // we only want one of these
      return setTimeout(fn, 100)
    }

    // I'm not sure how, but some other test in some other file keeps context
    // alive after it's done, meaning this test here runs in its async context.
    // If we don't no-op the server inside it, it will trace it, which will
    // screw up this test file entirely. -- bengl
    storage.run({ noop: true }, () => {
      traceAgent = http.createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) {
          chunks.push(chunk)
        }
        req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        traceAgent.reqs.push(req)
        traceAgent.emit('handled-req')
        res.end()
      }).listen(0, done)
    })

    traceAgent.reqs = []

    telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      }
    })

    pluginsByName = {
      foo2: { _enabled: true },
      bar2: { _enabled: false }
    }

    const circularObject = {
      child: { parent: null, field: 'child_value' },
      field: 'parent_value'
    }
    circularObject.child.parent = circularObject

    telemetry.start({
      telemetry: { enabled: true, heartbeatInterval: HEARTBEAT_INTERVAL },
      hostname: 'localhost',
      port: traceAgent.address().port,
      service: 'test service',
      version: '1.2.3-beta4',
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      },
      circularObject,
      appsec: { enabled: true },
      profiling: { enabled: true },
      peerServiceMapping: {
        'service_1': 'remapped_service_1',
        'service_2': 'remapped_service_2'
      }
    }, {
      _pluginsByName: pluginsByName
    })
  })

  after(() => {
    telemetry.stop()
    traceAgent.close()
    global.setInterval = origSetInterval
  })

  it('should send app-started', () => {
    return testSeq(1, 'app-started', payload => {
      expect(payload).to.have.property('products').that.deep.equal({
        appsec: { enabled: true },
        profiler: { version: '5.0.0-pre', enabled: true }
      })
      expect(payload).to.have.property('configuration').that.deep.equal([
        { name: 'telemetry.enabled', value: true },
        { name: 'telemetry.heartbeatInterval', value: DEFAULT_HEARTBEAT_INTERVAL },
        { name: 'hostname', value: 'localhost' },
        { name: 'port', value: traceAgent.address().port },
        { name: 'service', value: 'test service' },
        { name: 'version', value: '1.2.3-beta4' },
        { name: 'env', value: 'preprod' },
        { name: 'tags.runtime-id', value: '1a2b3c' },
        { name: 'circularObject.child.field', value: 'child_value' },
        { name: 'circularObject.field', value: 'parent_value' },
        { name: 'appsec.enabled', value: true },
        { name: 'profiling.enabled', value: true },
        { name: 'peerServiceMapping.service_1', value: 'remapped_service_1' },
        { name: 'peerServiceMapping.service_2', value: 'remapped_service_2' }
      ])
      expect(payload).to.have.property('additional_payload').that.deep.equal([])
    })
  })

  it('should send app-integrations', () => {
    return testSeq(2, 'app-integrations-change', payload => {
      expect(payload).to.deep.equal({
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true }
        ]
      })
    })
  })

  it('should send app-integrations-change', () => {
    pluginsByName.baz2 = { _enabled: true }
    telemetry.updateIntegrations()

    return testSeq(3, 'app-integrations-change', payload => {
      expect(payload).to.deep.equal({
        integrations: [
          { name: 'baz2', enabled: true, auto_enabled: true }
        ]
      })
    })
  })

  it('should send app-integrations-change', () => {
    pluginsByName.boo2 = { _enabled: true }
    telemetry.updateIntegrations()

    return testSeq(4, 'app-integrations-change', payload => {
      expect(payload).to.deep.equal({
        integrations: [
          { name: 'boo2', enabled: true, auto_enabled: true }
        ]
      })
    })
  })

  // TODO: make this work regardless of the test runner
  it.skip('should send app-closing', () => {
    process.emit('beforeExit')
    return testSeq(6, 'app-closing', payload => {
      expect(payload).to.deep.equal({})
    })
  })

  it('should do nothing when not enabled', (done) => {
    telemetry.stop()

    const server = http.createServer(() => {
      expect.fail('server should not be called')
    }).listen(0, () => {
      telemetry.start({
        telemetry: { enabled: false, heartbeatInterval: 60000 },
        hostname: 'localhost',
        port: server.address().port
      })

      setTimeout(() => {
        server.close()
        done()
      }, 10)
    })
  })
})

describe('Telemetry retry', () => {
  let clock
  let telemetry
  let capturedRequestType
  let capturedPayload
  let count = 0
  const HEARTBEAT_INTERVAL = 60000
  const pluginsByName = {
    foo2: { _enabled: true },
    bar2: { _enabled: false }
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })
  afterEach(() => {
    clock.restore()
    sinon.restore()
  })

  // after(() => {
  //   // telemetry.telemetry.stop()
  //   // traceAgent.close()
  // })

  it('should retry data on next cycle', () => {
    const sendDataError = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        capturedRequestType = reqType
        capturedPayload = payload

        if (count < 2) {
          count += 1
          return
        }

        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload: payload,
          reqType: 'app-integrations-change'
        })
      }

    }
    telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': sendDataError
    })

    telemetry.start({
      telemetry: { enabled: true, heartbeatInterval: HEARTBEAT_INTERVAL },
      hostname: 'localhost',
      port: 0,
      service: 'test service',
      version: '1.2.3-beta4',
      appsec: { enabled: true },
      profiling: { enabled: true },
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      }
    }, {
      _pluginsByName: pluginsByName
    })

    pluginsByName.boo3 = { _enabled: true }
    telemetry.updateIntegrations()
    expect(capturedRequestType).to.equal('app-integrations-change')

    expect(capturedPayload).to.deep.equal({
      'integrations': [{
        name: 'boo3',
        enabled: true,
        auto_enabled: true
      }]
    })

    clock.tick(3000)
    pluginsByName.boo5 = { _enabled: true }
    telemetry.updateIntegrations()
    expect(capturedRequestType).to.equal('message-batch')
    expect(capturedPayload).to.deep.equal([{
      request_type: 'app-integrations-change',
      payload: {
        'integrations': [{
          name: 'boo5',
          enabled: true,
          auto_enabled: true
        }]
      }

    }, {
      request_type: 'app-integrations-change',
      payload: {
        'integrations': [{
          name: 'boo3',
          enabled: true,
          auto_enabled: true
        }]
      }

    }]
    )
  })

  it('should send regular request after completed batch request ', () => {
    const sendDataError = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        capturedRequestType = reqType
        capturedPayload = payload

        // skipping startup command
        if (reqType === 'app-started' || reqType === 'message-batch') {
          cb()
          return
        }

        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload: payload,
          reqType: 'app-integrations-change'
        })
      }

    }
    telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': sendDataError
    })

    telemetry.start({
      telemetry: { enabled: true, heartbeatInterval: HEARTBEAT_INTERVAL },
      hostname: 'localhost',
      port: 0,
      service: 'test service',
      version: '1.2.3-beta4',
      appsec: { enabled: true },
      profiling: { enabled: true },
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      }
    }, {
      _pluginsByName: pluginsByName
    })
    pluginsByName.foo1 = { _enabled: true }
    telemetry.updateIntegrations() // This sends an batch message and succeeds

    pluginsByName.zoo1 = { _enabled: true }
    telemetry.updateIntegrations()
    expect(capturedRequestType).to.equal('app-integrations-change')

    expect(capturedPayload).to.deep.equal({
      'integrations': [{
        name: 'zoo1',
        enabled: true,
        auto_enabled: true
      }]
    })
  })
})

async function testSeq (seqId, reqType, validatePayload) {
  while (traceAgent.reqs.length < seqId) {
    await once(traceAgent, 'handled-req')
  }
  const req = traceAgent.reqs[seqId - 1]
  // console.log('SEQ ID', seqId)
  // console.log(req.body.tracer_time)
  expect(req.method).to.equal('POST')
  expect(req.url).to.equal(`/telemetry/proxy/api/v2/apmtelemetry`)
  expect(req.headers).to.include({
    'content-type': 'application/json',
    'dd-telemetry-api-version': 'v2',
    'dd-telemetry-request-type': reqType
  })
  const osName = os.type()
  let host = {
    hostname: os.hostname(),
    os: osName
  }
  if (osName === 'Linux' || osName === 'Darwin') {
    host = {
      hostname: os.hostname(),
      os: osName,
      architecture: os.arch(),
      kernel_version: os.version(),
      kernel_release: os.release(),
      kernel_name: osName
    }
  } else if (osName === 'Windows_NT') {
    host = {
      hostname: os.hostname(),
      os: osName,
      os_version: os.version(),
      architecture: os.arch()
    }
  }
  expect(req.body).to.deep.include({
    api_version: 'v2',
    request_type: reqType,
    runtime_id: '1a2b3c',
    seq_id: seqId,
    application: {
      service_name: 'test service',
      env: 'preprod',
      service_version: '1.2.3-beta4',
      tracer_version: tracerVersion,
      language_name: 'nodejs',
      language_version: process.versions.node
    },
    host
  })
  expect([1, 0, -1].includes(Math.floor(Date.now() / 1000) - req.body.tracer_time)).to.be.true

  validatePayload(req.body.payload)
}
