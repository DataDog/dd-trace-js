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
  expect([1, 0, -1].includes(Math.floor(Date.now() / 1000) - req.body.tracer_time)).to.be.true

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

describe('telemetry.getDependencies', () => {
  let telemetry
  let origSetInterval
  const pkg = {}
  const request = sinon.stub()
  const requirePackageJson = sinon.stub()
  const instrumenter = {
    '_instrumented': {
      keys () { return [] }
    }
  }
  const pluginManager = {
    '_pluginsByName': []
  }
  const config = {
    telemetryEnabled: true,
    tags: {
      'runtime-id': 'a1b2c3'
    }
  }
  beforeEach(() => {
    origSetInterval = setInterval

    global.setInterval = () => { return { unref: function () {} } }
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
      },
      './exporters/common/request': request,
      './require-package-json': requirePackageJson,
      './pkg': pkg
    })
  })

  afterEach(() => {
    telemetry.stop()
    global.setInterval = origSetInterval
    request.reset()
    requirePackageJson.reset()
    sinon.restore()
  })

  it('should not fail without dependencies', () => {
    pkg.dependencies = undefined
    request.callsFake(function (datastring) {
      const data = JSON.parse(datastring)
      expect(data.payload.dependencies).to.have.length(0)
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
  })

  it('should not fail with empty dependencies', () => {
    pkg.dependencies = null
    request.callsFake(function (datastring) {
      const data = JSON.parse(datastring)
      expect(data.payload.dependencies).to.have.length(0)
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
    expect(requirePackageJson).not.to.have.been.called
  })

  it('should return main package.json version without node_modules package.json', () => {
    pkg.dependencies = {
      'test_dep': '^1.0.0'
    }
    requirePackageJson.returns(null)
    request.callsFake(function (datastring) {
      const data = JSON.parse(datastring)
      expect(data.payload.dependencies).to.have.length(1)
      expect(data.payload.dependencies[0].version).to.be.equals('^1.0.0')
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
  })

  it('should return version in node_modules package.json', () => {
    pkg.dependencies = {
      'test_dep': '^1.0.0'
    }
    requirePackageJson.returns({ version: '1.0.8' })
    request.callsFake(function (dataString) {
      const data = JSON.parse(dataString)
      expect(data.payload.dependencies).to.have.length(1)
      expect(data.payload.dependencies[0].version).to.be.equals('1.0.8')
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
  })

  it('should return transitive dependencies', () => {
    pkg.dependencies = {
      'test_dep': '^1.0.0'
    }
    requirePackageJson.callsFake((modulePath) => {
      if (modulePath.indexOf('node_modules/test_dep') > -1) {
        return {
          dependencies: {
            'transitive_dep': '~2.4.2'
          },
          version: '1.0.8'
        }
      } else if (modulePath.indexOf('node_modules/transitive_dep') > -1) {
        return {
          version: '2.4.2'
        }
      }
      return {}
    })
    request.callsFake(function (dataString) {
      const data = JSON.parse(dataString)
      expect(data.payload.dependencies).to.have.length(2)
      expect(data.payload.dependencies[1].version).to.be.equals('1.0.8')
      expect(data.payload.dependencies[0].version).to.be.equals('2.4.2')
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
  })

  it('should not repeat dependencies', () => {
    pkg.dependencies = {
      'test_dep1': '^1.0.0',
      'test_dep2': '^2.0.1'
    }
    requirePackageJson.callsFake((modulePath) => {
      if (modulePath.indexOf('node_modules/test_dep1') > -1) {
        return {
          dependencies: {
            'transitive_dep': '~2.4.2'
          },
          version: '1.0.8'
        }
      } else if (modulePath.indexOf('node_modules/test_dep2') > -1) {
        return {
          dependencies: {
            'transitive_dep': '~2.4.1'
          },
          version: '2.0.2'
        }
      } else if (modulePath.indexOf('node_modules/transitive_dep') > -1) {
        return {
          version: '2.4.2'
        }
      }
      return {}
    })
    request.callsFake(function (dataString) {
      const data = JSON.parse(dataString)
      expect(data.payload.dependencies).to.have.length(3)
      expect(data.payload.dependencies[2].name).to.be.equals('test_dep2')
      expect(data.payload.dependencies[2].version).to.be.equals('2.0.2')
      expect(data.payload.dependencies[1].name).to.be.equals('test_dep1')
      expect(data.payload.dependencies[1].version).to.be.equals('1.0.8')
      expect(data.payload.dependencies[0].name).to.be.equals('transitive_dep')
      expect(data.payload.dependencies[0].version).to.be.equals('2.4.2')
    })
    telemetry.start(config, instrumenter, pluginManager)
    expect(request).to.have.been.calledOnce
  })
})
