'use strict'

require('../setup/tap')

const tracerVersion = require('../../../../package.json').version
const proxyquire = require('proxyquire')
const http = require('http')
const { once } = require('events')
const { storage } = require('../../../datadog-core')
const os = require('os')
const sinon = require('sinon')

const DEFAULT_HEARTBEAT_INTERVAL = 60000

let traceAgent

describe('telemetry', () => {
  let telemetry
  let pluginsByName

  before(done => {
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
      telemetry: { enabled: true, heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL },
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
      },
      installSignature: {
        id: '68e75c48-57ca-4a12-adfc-575c4b05fcbe',
        type: 'k8s_single_step',
        time: '1703188212'
      }
    }, {
      _pluginsByName: pluginsByName
    })
  })

  after(() => {
    telemetry.stop()
    traceAgent.close()
  })

  it('should send app-started', () => {
    return testSeq(1, 'app-started', payload => {
      expect(payload).to.have.property('products').that.deep.equal({
        appsec: { enabled: true },
        profiler: { version: tracerVersion, enabled: true }
      })
      expect(payload).to.have.property('install_signature').that.deep.equal({
        install_id: '68e75c48-57ca-4a12-adfc-575c4b05fcbe',
        install_type: 'k8s_single_step',
        install_time: '1703188212'
      })
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

  // TODO: test it's called on beforeExit instead of calling directly
  it('should send app-closing', () => {
    telemetry.appClosing()
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
      clearTimeout()
    })
  })

  it('should not send app-closing if telemetry is not enabled', () => {
    const sendDataStub = sinon.stub()
    const notEnabledTelemetry = proxyquire('../../src/telemetry', {
      './send-data': {
        sendData: sendDataStub
      }
    })
    notEnabledTelemetry.start({
      telemetry: { enabled: false, heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL },
      appsec: { enabled: false },
      profiling: { enabled: false }
    }, {
      _pluginsByName: pluginsByName
    })
    notEnabledTelemetry.appClosing()
    expect(sendDataStub.called).to.be.false
  })
})

describe('telemetry app-heartbeat', () => {
  let telemetry
  const HEARTBEAT_INTERVAL = 60

  before(done => {
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
      appsec: { enabled: false },
      profiling: { enabled: false }
    }, {
      _pluginsByName: {}
    })
  })

  after(() => {
    setTimeout(() => {
      telemetry.stop()
      traceAgent.close()
    }, HEARTBEAT_INTERVAL * 3)
    clearTimeout()
  })

  // flaky, will need to look into this later
  it.skip('should send app-heartbeat at uniform intervals', (done) => {
    function getHeartbeatCount () {
      let heartbeatCount = 0
      const reqCount = traceAgent.reqs.length
      for (let i = 0; i < reqCount; i++) {
        const req = traceAgent.reqs[i]
        if (req.headers && req.headers['dd-telemetry-request-type'] === 'app-heartbeat') {
          heartbeatCount++
        }
      }
      return heartbeatCount
    }

    // TODO: switch to clock.tick
    // for some reason clock.tick works with the other tests but not this one
    // Ida Liu spent fruitless hours to investigate ;u;
    setTimeout(() => {
      expect(getHeartbeatCount()).to.be.equal(0)
    }, HEARTBEAT_INTERVAL * 0.75)
    setTimeout(() => {
      expect(getHeartbeatCount()).to.be.equal(1)
    }, HEARTBEAT_INTERVAL * 1.2)
    setTimeout(() => {
      expect(getHeartbeatCount()).to.be.equal(1)
    }, HEARTBEAT_INTERVAL * 1.9)
    setTimeout(() => {
      expect(getHeartbeatCount()).to.be.equal(2)
      done()
    }, HEARTBEAT_INTERVAL * 2.1)
  })
})

describe('Telemetry extended heartbeat', () => {
  const HEARTBEAT_INTERVAL = 43200000
  let telemetry
  let pluginsByName
  let clock

  beforeEach(() => {
    clock = sinon.useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
    telemetry.stop()
    traceAgent.close()
  })

  it('should be sent every 24 hours', (done) => {
    let extendedHeartbeatRequest
    let beats = 0 // to keep track of the amont of times extendedHeartbeat is called
    const sendDataRequest = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        if (reqType === 'app-started') {
          cb()
          return
        }

        if (reqType === 'app-extended-heartbeat') {
          beats++
          extendedHeartbeatRequest = reqType
        }
      }

    }
    telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': sendDataRequest
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
    clock.tick(86400000)
    expect(extendedHeartbeatRequest).to.equal('app-extended-heartbeat')
    expect(beats).to.equal(1)
    clock.tick(86400000)
    expect(beats).to.equal(2)
    done()
  })

  it('be sent with up-to-date configuration values', (done) => {
    let configuration
    const sendDataRequest = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        if (reqType === 'app-extended-heartbeat') {
          configuration = payload.configuration
        }
      }

    }
    telemetry = proxyquire('../../src/telemetry', {
      '../exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      './send-data': sendDataRequest
    })

    const config = {
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
    }

    telemetry.start(config, { _pluginsByName: pluginsByName })

    clock.tick(86400000)
    expect(configuration).to.deep.equal([])

    const changes = [
      {
        name: 'test',
        value: true,
        origin: 'code'
      }
    ]
    telemetry.updateConfig(changes, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(changes)

    const updatedChanges = [
      {
        name: 'test',
        value: false,
        origin: 'code'
      }
    ]
    telemetry.updateConfig(updatedChanges, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(updatedChanges)

    const changeNeedingNameRemapping = [
      {
        name: 'sampleRate', // one of the config names that require a remapping
        value: 0,
        origin: 'code'
      }
    ]
    const expectedConfigList = [
      updatedChanges[0],
      {
        ...changeNeedingNameRemapping[0],
        name: 'DD_TRACE_SAMPLE_RATE' // remapped name
      }
    ]
    telemetry.updateConfig(changeNeedingNameRemapping, config)
    clock.tick(86400000)
    expect(configuration).to.deep.equal(expectedConfigList)
    done()
  })
})

// deleted this test for now since the global interval is now used for app-extended heartbeat
// which is not supposed to be configurable
// will ask Bryan why being able to change the interval is important after he is back from parental leave
describe('Telemetry retry', () => {
  let telemetry
  let capturedRequestType
  let capturedPayload
  let count = 0
  let pluginsByName
  let clock
  const HEARTBEAT_INTERVAL = 60000

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    pluginsByName = {
      foo2: { _enabled: true },
      bar2: { _enabled: false }
    }
  })
  afterEach(() => {
    clock.restore()
  })

  it('should retry data on next app change', () => {
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

  it('should retry data on next heartbeat', () => {
    const sendDataError = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        // skipping startup command
        if (reqType === 'app-started') {
          cb()
          return
        }
        // skipping startup command
        if (reqType === 'message-batch') {
          capturedRequestType = reqType
          capturedPayload = payload
          cb()
          return
        }
        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload: payload,
          reqType: reqType
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
    // jump to next heartbeat request
    clock.tick(HEARTBEAT_INTERVAL)
    expect(capturedRequestType).to.equal('message-batch')
    expect(capturedPayload).to.deep.equal([{
      request_type: 'app-heartbeat',
      payload: {}
    }, {
      request_type: 'app-integrations-change',
      payload: {
        'integrations': [{
          name: 'foo2',
          enabled: true,
          auto_enabled: true
        },
        {
          name: 'bar2',
          enabled: false,
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

  it('should updated batch request after previous fail', () => {
    const sendDataError = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        capturedRequestType = reqType
        capturedPayload = payload

        // skipping startup command
        if (reqType === 'app-started') {
          cb()
          return
        }

        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload: payload,
          reqType: reqType
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

    // Start function sends 2 messages app-started & app-integrations-change
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
    telemetry.updateIntegrations() // This sends an batch message and fails

    pluginsByName.zoo1 = { _enabled: true }
    telemetry.updateIntegrations()

    expect(capturedRequestType).to.equal('message-batch')
    expect(capturedPayload).to.deep.equal([{
      request_type: 'app-integrations-change',
      payload: {
        'integrations': [{
          name: 'zoo1',
          enabled: true,
          auto_enabled: true
        }]
      }

    }, {
      request_type: 'app-integrations-change',
      payload: {
        'integrations': [{
          name: 'foo1',
          enabled: true,
          auto_enabled: true
        }]
      }

    }]
    )
  })

  it('should set extended heartbeat payload', async () => {
    let extendedHeartbeatRequest
    let extendedHeartbeatPayload
    const sendDataError = {
      sendData: (config, application, host, reqType, payload, cb = () => {}) => {
        // skipping startup command
        if (reqType === 'app-started') {
          cb()
          return
        }

        if (reqType === 'app-extended-heartbeat') {
          extendedHeartbeatRequest = reqType
          extendedHeartbeatPayload = payload
          return
        }

        // Simulate an HTTP error by calling the callback with an error
        cb(new Error('HTTP request error'), {
          payload: payload,
          reqType: reqType
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

    // Start function sends 2 messages app-started & app-integrations-change
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
    },
    {
      _pluginsByName: pluginsByName
    })
    pluginsByName.foo1 = { _enabled: true }
    telemetry.updateIntegrations() // This sends an batch message and fails
    // Skip forward a day
    clock.tick(86400000)
    expect(extendedHeartbeatRequest).to.equal('app-extended-heartbeat')
    expect(extendedHeartbeatPayload).to.haveOwnProperty('integrations')
    expect(extendedHeartbeatPayload['integrations']).to.deep.include({
      integrations: [
        { name: 'foo2', enabled: true, auto_enabled: true },
        { name: 'bar2', enabled: false, auto_enabled: true }
      ]
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
    naming_schema_version: '',
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
