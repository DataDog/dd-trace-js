'use strict'

const assert = require('node:assert/strict')

const sinon = require('sinon')

require('../setup/core')
const BunSQLPlugin = require('../../../datadog-plugin-bun-sql/src')
const { CLIENT_PORT_KEY } = require('../../src/constants')

describe('BunSQLPlugin', () => {
  let plugin
  let span
  let service

  beforeEach(() => {
    plugin = new BunSQLPlugin({ _service: 'test', _env: 'test', _version: '1.0' })
    plugin.configure({ enabled: false })
    span = {}
    service = { name: 'test-db', source: 'opt.plugin' }
    sinon.stub(plugin, 'serviceName').returns(service)
    sinon.stub(plugin, 'operationName').returns('bun-sql.query')
    sinon.stub(plugin, 'startSpan').returns(span)
    sinon.stub(plugin, 'injectDbmQuery').returns('/* dbm */ SELECT 1')
  })

  afterEach(() => sinon.restore())

  for (const adapter of ['postgres', 'mysql', 'sqlite']) {
    for (const prepared of [false, true]) {
      it(`creates a ${adapter} span and delegates DBM with prepared=${prepared}`, () => {
        const ctx = {
          statement: 'SELECT 1',
          adapter,
          hostname: 'db.internal',
          port: 1234,
          database: 'orders',
          username: 'reader',
          prepared,
          currentStore: { span },
        }

        assert.strictEqual(plugin.bindStart(ctx), ctx.currentStore)
        sinon.assert.calledOnceWithExactly(plugin.serviceName, { pluginConfig: plugin.config, system: adapter })
        sinon.assert.calledOnceWithExactly(plugin.operationName, { system: adapter })
        sinon.assert.calledOnceWithExactly(plugin.startSpan, 'bun-sql.query', {
          service,
          resource: 'SELECT 1',
          type: 'sql',
          kind: 'client',
          meta: {
            'db.type': adapter,
            'db.name': 'orders',
            'db.user': 'reader',
            'out.host': 'db.internal',
            [CLIENT_PORT_KEY]: 1234,
          },
        }, ctx)

        if (adapter === 'sqlite') {
          sinon.assert.notCalled(plugin.injectDbmQuery)
          assert.strictEqual(ctx.statement, 'SELECT 1')
        } else {
          sinon.assert.calledOnceWithExactly(plugin.injectDbmQuery, span, 'SELECT 1', service.name, prepared)
          assert.strictEqual(ctx.statement, '/* dbm */ SELECT 1')
        }
      })
    }
  }

  it('accepts empty SQL and absent connection metadata', () => {
    const ctx = { statement: '', adapter: 'sqlite', prepared: false }

    assert.strictEqual(plugin.bindStart(ctx), undefined)
    assert.strictEqual(plugin.startSpan.firstCall.args[1].resource, '')
    assert.deepStrictEqual(plugin.startSpan.firstCall.args[1].meta, {
      'db.type': 'sqlite',
      'db.name': undefined,
      'db.user': undefined,
      'out.host': undefined,
      [CLIENT_PORT_KEY]: undefined,
    })
    sinon.assert.notCalled(plugin.injectDbmQuery)
  })
})
