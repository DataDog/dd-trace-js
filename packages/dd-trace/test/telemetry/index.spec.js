'use strict'

require('../setup/tap')

const tracerVersion = require('../../../../package.json').version
const proxyquire = require('proxyquire')
const http = require('http')
const { once } = require('events')
const { storage } = require('../../../datadog-core')
const os = require('os')

let traceAgent

describe('telemetry', () => {
  const HEARTBEAT_INTERVAL = 60000
  let origSetInterval
  let telemetry
  let pluginsByName

  before(done => {
    origSetInterval = setInterval

    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(HEARTBEAT_INTERVAL)
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
      expect(payload).to.deep.include({
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true }
        ],
        dependencies: []
      }).and.to.have.property('configuration').that.include.members([
        { name: 'telemetry.enabled', value: true },
        { name: 'hostname', value: 'localhost' },
        { name: 'port', value: traceAgent.address().port },
        { name: 'service', value: 'test service' },
        { name: 'version', value: '1.2.3-beta4' },
        { name: 'env', value: 'preprod' },
        { name: 'tags.runtime-id', value: '1a2b3c' },
        { name: 'circularObject.field', value: 'parent_value' },
        { name: 'circularObject.child.field', value: 'child_value' },
        { name: 'peerServiceMapping', value: 'service_1:remapped_service_1,service_2:remapped_service_2' }
      ])
    })
  })

  it('should send app-integrations-change', () => {
    pluginsByName.baz2 = { _enabled: true }
    telemetry.updateIntegrations()

    return testSeq(2, 'app-integrations-change', payload => {
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

    return testSeq(3, 'app-integrations-change', payload => {
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
    return testSeq(5, 'app-closing', payload => {
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

describe('telemetry app-heartbeat', () => {
  const HEARTBEAT_INTERVAL = 60
  let origSetInterval
  let telemetry
  let pluginsByName

  before(done => {
    origSetInterval = setInterval

    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(HEARTBEAT_INTERVAL)
      // we only want one of these
      return setTimeout(fn, 100)
    }

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
      circularObject
    }, {
      _pluginsByName: pluginsByName
    })
  })

  after(() => {
    setTimeout(() => {
      telemetry.stop()
      traceAgent.close()
      global.setInterval = origSetInterval
    }, HEARTBEAT_INTERVAL * 3)
  })

  it('should send app-heartbeat at uniform intervals', () => {
    // TODO: switch to clock.tick
    setTimeout(() => {
      const heartbeats = []
      const reqCount = traceAgent.reqs.length
      for (let i = 0; i < reqCount; i++) {
        const req = traceAgent.reqs[i]
        if (req.headers && req.headers['dd-telemetry-request-type'] === 'app-heartbeat') {
          heartbeats.push(req.body.tracer_time)
        }
      }
      expect(heartbeats.length).to.be.greaterThanOrEqual(2)
      for (let k = 0; k++; k < heartbeats.length - 1) {
        expect(heartbeats[k + 1] - heartbeats[k]).to.be.equal(1)
      }
    }, HEARTBEAT_INTERVAL * 3)
  })
})

describe('telemetry with interval change', () => {
  it('should set the interval correctly', (done) => {
    const telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': {
        sendData: () => {}
      }
    })

    let intervalSetCorrectly
    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(12345000)
      intervalSetCorrectly = true
      return setTimeout(fn, 1)
    }

    telemetry.start({
      telemetry: { enabled: true, heartbeatInterval: 12345000 },
      hostname: 'localhost',
      port: 8126,
      service: 'test service',
      version: '1.2.3-beta4',
      env: 'preprod',
      tags: {
        'runtime-id': '1a2b3c'
      }
    }, {
      _pluginsByName: {}
    })

    process.nextTick(() => {
      expect(intervalSetCorrectly).to.be.true
      telemetry.stop()
      done()
    })
  })
})

async function testSeq (seqId, reqType, validatePayload) {
  while (traceAgent.reqs.length < seqId) {
    await once(traceAgent, 'handled-req')
  }
  const req = traceAgent.reqs[seqId - 1]
  expect(req.method).to.equal('POST')
  expect(req.url).to.equal(`/telemetry/proxy/api/v2/apmtelemetry`)
  expect(req.headers).to.include({
    'content-type': 'application/json',
    'dd-telemetry-api-version': 'v1',
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
    api_version: 'v1',
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
