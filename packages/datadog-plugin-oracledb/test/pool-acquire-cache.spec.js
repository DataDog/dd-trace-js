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
      homogeneous: true,
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

  it('uses the acquired connection user override', () => {
    const span = {
      finish: sinon.spy(),
      setTag: sinon.spy(),
    }

    plugin.finish({ currentStore: { span }, user: 'proxy' })

    sinon.assert.calledOnceWithExactly(span.setTag, 'db.user', 'proxy')
    sinon.assert.calledOnce(span.finish)
  })

  it('omits the pool user for a heterogeneous acquisition', () => {
    ctx.connectionAttrs.homogeneous = false

    plugin.bindStart(ctx)

    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['db.user'], undefined)
  })

  it('keeps the pool user without an acquired connection override', () => {
    const span = {
      finish: sinon.spy(),
      setTag: sinon.spy(),
    }

    plugin.finish({ currentStore: { span } })

    sinon.assert.notCalled(span.setTag)
    sinon.assert.calledOnce(span.finish)
  })

  it('caches dynamic services by pool parameters', () => {
    let calls = 0
    plugin.configure({ enabled: false, service: params => `${params.user}-${++calls}` })

    plugin.bindStart(ctx)
    plugin.bindStart(ctx)
    const otherCtx = makeContext()
    otherCtx.poolAttrs.user = 'other'
    plugin.bindStart(otherCtx)

    assert.strictEqual(nomenclature.opName.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'test-1')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'test-1')
    assert.strictEqual(tracer.startSpan.thirdCall.args[1].tags['service.name'], 'other-2')
  })
})
