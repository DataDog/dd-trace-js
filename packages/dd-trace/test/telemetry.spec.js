'use strict'

const tracerVersion = require('../../../package.json').version
const proxyquire = require('proxyquire')
const requirePackageJson = require('../src/require-package-json')
const http = require('http')
const { once } = require('events')
const { storage } = require('../../datadog-core')

let traceAgent

describe('telemetry', () => {
  let origSetInterval
  let telemetry
  let instrumentedMap
  let pluginsByName

  before(done => {
    origSetInterval = setInterval

    global.setInterval = (fn, interval) => {
      expect(interval).to.equal(60000)
      // we only want one of these
      return setImmediate(fn)
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

    telemetry = proxyquire('../src/telemetry', {
      './exporters/common/docker': {
        id () {
          return 'test docker id'
        }
      },
      os: {
        hostname () {
          return 'test hostname'
        }
      }
    })

    instrumentedMap = new Map([
      [{ name: 'foo' }, {}],
      [{ name: 'bar' }, {}]
    ])

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
      telemetryEnabled: true,
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
      _instrumented: instrumentedMap
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
          { name: 'foo', enabled: true, auto_enabled: true },
          { name: 'bar', enabled: true, auto_enabled: true },
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true }
        ],
        dependencies: getMochaDeps()
      }).and.to.have.property('configuration').that.include.members([
        { name: 'telemetryEnabled', value: true },
        { name: 'hostname', value: 'localhost' },
        { name: 'port', value: traceAgent.address().port },
        { name: 'service', value: 'test service' },
        { name: 'version', value: '1.2.3-beta4' },
        { name: 'env', value: 'preprod' },
        { name: 'tags.runtime-id', value: '1a2b3c' },
        { name: 'circularObject.field', value: 'parent_value' },
        { name: 'circularObject.child.field', value: 'child_value' }
      ])
    })
  })

  it('should send app-heartbeat', () => {
    return testSeq(2, 'app-heartbeat', payload => {
      expect(payload).to.deep.equal({})
    })
  })

  it('should send app-integrations-change', () => {
    instrumentedMap.set({ name: 'baz' }, {})
    pluginsByName.baz2 = { _enabled: true }
    telemetry.updateIntegrations()

    return testSeq(3, 'app-integrations-change', payload => {
      expect(payload).to.deep.equal({
        integrations: [
          { name: 'baz', enabled: true, auto_enabled: true },
          { name: 'baz2', enabled: true, auto_enabled: true }
        ]
      })
    })
  })

  it('should send app-integrations-change', () => {
    instrumentedMap.set({ name: 'boo' }, {})
    pluginsByName.boo2 = { _enabled: true }
    telemetry.updateIntegrations()

    return testSeq(4, 'app-integrations-change', payload => {
      expect(payload).to.deep.equal({
        integrations: [
          { name: 'boo', enabled: true, auto_enabled: true },
          { name: 'boo2', enabled: true, auto_enabled: true }
        ]
      })
    })
  })

  it('should send app-closing', () => {
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
        telemetryEnabled: false,
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
    host: {
      hostname: 'test hostname',
      container_id: 'test docker id'
    }
  })
  expect(Math.floor(Date.now() / 1000 - req.body.tracer_time)).to.equal(0)

  validatePayload(req.body.payload)
}

// Since the entrypoint file is actually a mocha script, the deps will be mocha's deps
function getMochaDeps () {
  const mochaPkgJsonFile = require.resolve('mocha/package.json')
  require('mocha')
  const mochaModule = require.cache[require.resolve('mocha')]
  const mochaDeps = require(mochaPkgJsonFile).dependencies
  return Object.keys(mochaDeps).map((name) => ({
    name,
    version: requirePackageJson(name, mochaModule).version
  }))
}
