'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../dd-trace/test/setup/core')

const RedisPlugin = require('../src')

function makeNomenclatureStub () {
  return {
    config: { spanAttributeSchema: 'v0', spanRemoveIntegrationFromService: false },
    opName () {
      return 'redis.command'
    },
    serviceName (type, kind, id, opts) {
      const { pluginConfig, system, connectionName } = opts
      if (pluginConfig.splitByInstance && connectionName) {
        if (this.config.spanAttributeSchema === 'v1') {
          return { name: pluginConfig.service || 'tracer-svc', source: 'opt.plugin' }
        }
        return {
          name: pluginConfig.service ? `${pluginConfig.service}-${connectionName}` : connectionName,
          source: 'opt.split_by_instance',
        }
      }
      return {
        name: pluginConfig.service || `tracer-svc-${system}`,
        source: pluginConfig.service ? 'opt.plugin' : system,
      }
    },
  }
}

function makeTracerStub (nomenclature, startSpan) {
  return {
    _service: 'tracer-svc',
    _nomenclature: nomenclature,
    startSpan,
  }
}

function makeCtx (connectionName) {
  return {
    db: 0,
    command: 'get',
    args: ['foo'],
    argsStartIndex: 0,
    connectionOptions: { host: '127.0.0.1', port: 6379 },
    connectionName,
    currentStore: {},
  }
}

describe('RedisPlugin bindStart service caching', () => {
  let plugin
  let nomenclature
  let startSpan

  beforeEach(() => {
    nomenclature = makeNomenclatureStub()
    startSpan = sinon.stub().returns({
      _spanContext: { _tags: {} },
      setTag () {},
      finish () {},
      addLink () {},
    })
    plugin = new RedisPlugin(makeTracerStub(nomenclature, startSpan), {
      codeOriginForSpans: { enabled: false, experimental: { exit_spans: { enabled: false } } },
    })
    plugin.configure({
      service: 'custom',
      splitByInstance: true,
      enabled: false,
    })
  })

  it('caches the service name across repeated bindStart calls with the same connection', () => {
    plugin.bindStart(makeCtx('test'))
    plugin.bindStart(makeCtx('test'))

    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'custom-test')
  })

  it('re-derives the service name when the nomenclature config flips (schema v0 -> v1)', () => {
    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')

    // Replace the object the way `SchemaManager.configure` does -- not mutate.
    nomenclature.config = {
      spanAttributeSchema: 'v1',
      spanRemoveIntegrationFromService: false,
    }

    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'custom')
  })

  it('clears the cache on configure() so a new plugin config takes effect', () => {
    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.firstCall.args[1].tags['service.name'], 'custom-test')

    plugin.configure({
      service: 'renamed',
      splitByInstance: true,
      enabled: false,
    })

    plugin.bindStart(makeCtx('test'))
    assert.strictEqual(startSpan.secondCall.args[1].tags['service.name'], 'renamed-test')
  })

  it('still caches across multiple connections separately', () => {
    plugin.bindStart(makeCtx('a'))
    plugin.bindStart(makeCtx('b'))
    plugin.bindStart(makeCtx('a'))
    plugin.bindStart(makeCtx('b'))

    const calls = startSpan.getCalls()
    assert.strictEqual(calls[0].args[1].tags['service.name'], 'custom-a')
    assert.strictEqual(calls[1].args[1].tags['service.name'], 'custom-b')
    assert.strictEqual(calls[2].args[1].tags['service.name'], 'custom-a')
    assert.strictEqual(calls[3].args[1].tags['service.name'], 'custom-b')
  })
})

describe('RedisPlugin bindStart retention', () => {
  it('does not retain long command argument storage', () => {
    const pluginPath = JSON.stringify(require.resolve('../src'))
    const script = `
      const RedisPlugin = require(${pluginPath})
      const values = new Array(400)
      let index = 0
      const span = {
        _spanContext: { _tags: {} },
        setTag () {},
        finish () {},
        addLink () {},
      }
      const tracer = {
        _service: 'test',
        _nomenclature: {
          config: {},
          opName () { return 'redis.command' },
          serviceName () { return { name: 'test-redis' } },
        },
        startSpan (name, options) {
          values[index++] = options.tags['redis.raw_command']
          return span
        },
      }
      const plugin = new RedisPlugin(tracer, {
        codeOriginForSpans: {
          enabled: false,
          experimental: { exit_spans: { enabled: false } },
        },
      })
      plugin.configure({ enabled: false })

      for (let i = 0; i < values.length; i++) {
        const parent = JSON.parse(JSON.stringify(
          String(i).padStart(6, '0') + 'x'.repeat(128 * 1024)
        ))
        plugin.bindStart({
          command: 'set',
          args: ['key', parent.slice(0, 257)],
          connectionOptions: { host: 'localhost', port: 6379 },
          currentStore: {},
        })
      }

      let retainedLength = 0
      for (const value of values) retainedLength += value.length
      process.stdout.write(String(retainedLength))
    `
    const result = spawnSync(process.execPath, ['--max-old-space-size=32', '--eval', script], { encoding: 'utf8' })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.strictEqual(result.stdout, '43200')
  })
})
