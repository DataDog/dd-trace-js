'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const QueryPlugin = require('../src/query')

function makeNomenclature () {
  return {
    config: { spanAttributeSchema: 'v0' },
    opName: sinon.spy(function (type, kind, id) {
      return `${id}.${this.config.spanAttributeSchema}.query`
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
    _env: 'test',
    _nomenclature: nomenclature,
    _service: 'test',
    _version: '1.0.0',
    startSpan: sinon.stub().returns({}),
  }
}

function makeContext () {
  return {
    connAttrs: {
      connectString: 'localhost:1521/xepdb1',
      user: 'test',
    },
    currentStore: {},
    dbInstance: 'xepdb1',
    hostname: 'localhost',
    port: '1521',
    query: 'select 1 from dual',
  }
}

describe('OracledbQueryPlugin naming cache', () => {
  let ctx
  let nomenclature
  let plugin
  let tracer

  beforeEach(() => {
    ctx = makeContext()
    nomenclature = makeNomenclature()
    tracer = makeTracer(nomenclature)
    plugin = new QueryPlugin(tracer, {
      codeOriginForSpans: {
        enabled: false,
        experimental: { exit_spans: { enabled: false } },
      },
    })
    plugin.configure({ dbmPropagationMode: 'disabled', enabled: false, service: 'custom' })
  })

  it('caches static naming across queries', () => {
    plugin.bindStart(ctx)
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 1)
    assert.strictEqual(tracer.startSpan.firstCall.args[0], 'oracledb.v0.query')
    assert.strictEqual(tracer.startSpan.secondCall.args[0], 'oracledb.v0.query')
  })

  it('caches dynamic services by connection parameters', () => {
    let calls = 0
    plugin.configure({
      dbmPropagationMode: 'disabled',
      enabled: false,
      service: params => `${params.user}-${++calls}`,
    })

    plugin.bindStart(ctx)
    plugin.bindStart(ctx)
    const otherCtx = makeContext()
    otherCtx.connAttrs.user = 'other'
    plugin.bindStart(otherCtx)

    assert.strictEqual(nomenclature.opName.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'test-1')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'test-1')
    assert.strictEqual(tracer.startSpan.thirdCall.args[1].tags['service.name'], 'other-2')
  })

  it('caches dynamic services without connection parameters', () => {
    plugin.configure({
      dbmPropagationMode: 'disabled',
      enabled: false,
      service: sinon.stub().returns('custom'),
    })
    ctx.connAttrs = undefined

    plugin.bindStart(ctx)
    plugin.bindStart(ctx)

    assert.strictEqual(plugin.config.service.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 1)
  })

  it('caches dynamic services by pool alias', () => {
    let calls = 0
    plugin.configure({
      dbmPropagationMode: 'disabled',
      enabled: false,
      service: params => `${params}-${++calls}`,
    })
    ctx.connAttrs = 'first'

    plugin.bindStart(ctx)
    plugin.bindStart(ctx)
    ctx.connAttrs = 'second'
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 1)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'first-1')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'first-1')
    assert.strictEqual(tracer.startSpan.thirdCall.args[1].tags['service.name'], 'second-2')
  })

  it('refreshes naming when nomenclature changes', () => {
    plugin.bindStart(ctx)
    nomenclature.config = { spanAttributeSchema: 'v1' }
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 2)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[0], 'oracledb.v0.query')
    assert.strictEqual(tracer.startSpan.secondCall.args[0], 'oracledb.v1.query')
  })

  it('refreshes naming when plugin configuration changes', () => {
    plugin.bindStart(ctx)
    plugin.configure({ dbmPropagationMode: 'disabled', enabled: false, service: 'renamed' })
    plugin.bindStart(ctx)

    assert.strictEqual(nomenclature.opName.callCount, 2)
    assert.strictEqual(nomenclature.serviceName.callCount, 2)
    assert.strictEqual(tracer.startSpan.firstCall.args[1].tags['service.name'], 'custom')
    assert.strictEqual(tracer.startSpan.secondCall.args[1].tags['service.name'], 'renamed')
  })
})
