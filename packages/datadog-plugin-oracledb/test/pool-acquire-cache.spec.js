'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const PoolAcquirePlugin = require('../src/pool-acquire')

function makeNomenclature () {
  return {
    config: { spanAttributeSchema: 'v0' },
    opName: sinon.spy(function (type, kind, id, opts) {
      return `${id}.${this.config.spanAttributeSchema}.${opts.operation}`
    }),
    serviceName: sinon.spy(function (type, kind, id, opts) {
      const configured = opts.pluginConfig.service
      const name = typeof configured === 'function' ? configured(opts.params) : configured
      return { name: name ?? `${id}-${this.config.spanAttributeSchema}`, source: id }
    }),
  }
}

function makeTracer (nomenclature) {
  return {
    _nomenclature: nomenclature,
    _service: 'test',
    startSpan: sinon.stub().returns({}),
  }
}

function makeContext () {
  return {
    connectionAttrs: {
      connectString: 'localhost:1521/xepdb1',
      user: 'test',
    },
    currentStore: {},
    pool: {},
    poolAttrs: {
      connectString: 'localhost:1521/xepdb1',
      user: 'test',
    },
  }
}

describe('OracledbPoolAcquirePlugin naming cache', () => {
  let ctx
  let nomenclature
  let plugin
  let tracer

  beforeEach(() => {
    ctx = makeContext()
    nomenclature = makeNomenclature()
    tracer = makeTracer(nomenclature)
    plugin = new PoolAcquirePlugin(tracer, {
      codeOriginForSpans: {
        enabled: false,
        experimental: { exit_spans: { enabled: false } },
      },
    })
    plugin.configure({ enabled: false, service: 'custom' })
  })

  it('caches static naming across acquisitions', () => {
    plugin.bindStart(ctx)
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 1)
    assert.strictEqual(tracer.startSpan.firstCall.args[0], 'oracledb.v0.pool.acquire')
    assert.strictEqual(tracer.startSpan.secondCall.args[0], 'oracledb.v0.pool.acquire')
  })

  it('refreshes naming when nomenclature changes', () => {
    plugin.bindStart(ctx)
    nomenclature.config = { spanAttributeSchema: 'v1' }
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 2)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[0], 'oracledb.v0.pool.acquire')
    assert.strictEqual(tracer.startSpan.secondCall.args[0], 'oracledb.v1.pool.acquire')
  })

  it('refreshes naming when plugin configuration changes', () => {
    plugin.bindStart(ctx)
    plugin.configure({ enabled: false, service: 'renamed' })
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 2)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'custom')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'renamed')
  })

  it('resolves dynamic services for every acquisition', () => {
    let service = 'first'
    plugin.configure({ enabled: false, service: () => service })

    plugin.bindStart(ctx)
    service = 'second'
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 2)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'first')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'second')
  })
})
