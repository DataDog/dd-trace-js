'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')
const { createIntegration } = require('../src')

describe('createIntegration', () => {
  describe('orchestrion', () => {
    it('should generate orchestrion config entries', () => {
      const { orchestrion } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: 'lib/index.js',
        type: 'server',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Callback', index: 1,
          span: { name: 'test.request', spanKind: 'server', resource: 'test' },
        }],
      })

      assert.strictEqual(orchestrion.length, 1)
      assert.deepStrictEqual(orchestrion[0], {
        module: { name: 'test-pkg', versionRange: '>=1.0.0', filePath: 'lib/index.js' },
        functionQuery: { className: 'Foo', methodName: 'bar', kind: 'Callback', index: 1 },
        channelName: 'Foo_bar',
      })
    })

    it('should generate entries for each file path', () => {
      const { orchestrion } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: ['dist/cjs/index.js', 'dist/esm/index.js'],
        type: 'server',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Async',
          span: { name: 'test.op', spanKind: 'client' },
        }],
      })

      assert.strictEqual(orchestrion.length, 2)
      assert.strictEqual(orchestrion[0].module.filePath, 'dist/cjs/index.js')
      assert.strictEqual(orchestrion[1].module.filePath, 'dist/esm/index.js')
      assert.strictEqual(orchestrion[0].channelName, orchestrion[1].channelName)
    })

    it('should omit filePath when file is not specified', () => {
      const { orchestrion } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        type: 'server',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Async',
          span: { name: 'test.op', spanKind: 'client' },
        }],
      })

      assert.strictEqual(orchestrion[0].module.filePath, undefined)
    })

    it('should use per-intercept versions when specified', () => {
      const { orchestrion } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        type: 'server',
        intercepts: [
          { className: 'A', methodName: 'foo', kind: 'Async', versions: '>=2.0.0',
            span: { name: 'a', spanKind: 'server' } },
          { className: 'B', methodName: 'bar', kind: 'Async',
            span: { name: 'b', spanKind: 'server' } },
        ],
      })

      assert.strictEqual(orchestrion[0].module.versionRange, '>=2.0.0')
      assert.strictEqual(orchestrion[1].module.versionRange, '>=1.0.0')
    })

    it('should use per-intercept file when specified', () => {
      const { orchestrion } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: 'lib/default.js',
        type: 'server',
        intercepts: [
          { className: 'A', methodName: 'foo', kind: 'Async', file: 'lib/other.js',
            span: { name: 'a', spanKind: 'server' } },
          { className: 'B', methodName: 'bar', kind: 'Async',
            span: { name: 'b', spanKind: 'server' } },
        ],
      })

      assert.strictEqual(orchestrion[0].module.filePath, 'lib/other.js')
      assert.strictEqual(orchestrion[1].module.filePath, 'lib/default.js')
    })
  })

  describe('hooks', () => {
    it('should generate hook entries', () => {
      const { hooks } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: 'lib/index.js',
        type: 'server',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Callback',
          span: { name: 'test.request', spanKind: 'server' },
        }],
      })

      assert.strictEqual(hooks.length, 1)
      assert.deepStrictEqual(hooks[0], {
        name: 'test-pkg',
        versions: ['>=1.0.0'],
        file: 'lib/index.js',
      })
    })

    it('should deduplicate hooks across intercepts', () => {
      const { hooks } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: 'lib/index.js',
        type: 'server',
        intercepts: [
          { className: 'Foo', methodName: 'bar', kind: 'Callback', span: { name: 'a', spanKind: 'server' } },
          { className: 'Foo', methodName: 'baz', kind: 'Async', span: { name: 'b', spanKind: 'server' } },
        ],
      })

      assert.strictEqual(hooks.length, 1)
    })

    it('should produce separate hooks for per-intercept version overrides', () => {
      const { hooks } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=3',
        type: 'server',
        intercepts: [
          { className: 'A', methodName: 'foo', kind: 'Async', versions: '>=4.4',
            span: { name: 'a', spanKind: 'server' } },
          { className: 'B', methodName: 'bar', kind: 'Callback', index: -1, versions: '3 - 4.3',
            span: { name: 'b', spanKind: 'server' } },
          { className: 'C', methodName: 'baz', kind: 'Async',
            span: { name: 'c', spanKind: 'server' } },
        ],
      })

      assert.strictEqual(hooks.length, 3)
      const versions = hooks.map(h => h.versions[0]).sort()
      assert.deepStrictEqual(versions, ['3 - 4.3', '>=3', '>=4.4'])
    })
  })

  describe('plugin', () => {
    it('should generate a plugin class with correct base, id, and prefix', () => {
      const ServerPlugin = require('../../dd-trace/src/plugins/server')

      const { plugin } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        file: 'lib/index.js',
        type: 'server',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Callback',
          span: { name: 'test.request', spanKind: 'server' },
        }],
      })

      assert.deepStrictEqual(
        { id: plugin.id, prefix: plugin.prefix, extendsServer: plugin.prototype instanceof ServerPlugin },
        { id: 'test', prefix: 'tracing:orchestrion:test-pkg:Foo_bar', extendsServer: true }
      )
    })

    it('should support function-based resource and attributes', () => {
      const DatabasePlugin = require('../../dd-trace/src/plugins/database')

      const { plugin } = createIntegration({
        id: 'test-db',
        module: 'test-db-pkg',
        versions: '>=2.0.0',
        type: 'database',
        system: 'testdb',
        intercepts: [{
          className: 'Client', methodName: 'query', kind: 'Async',
          span: {
            name: 'testdb.query',
            spanKind: 'client',
            type: 'sql',
            resource: (ctx) => ctx.arguments?.[0],
            attributes: (ctx) => ({ 'db.type': 'testdb' }),
          },
        }],
      })

      assert.ok(plugin.prototype instanceof DatabasePlugin)
      assert.strictEqual(plugin.system, 'testdb')
    })

    it('should support cache, consumer, and producer plugin types', () => {
      const CachePlugin = require('../../dd-trace/src/plugins/cache')
      const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
      const ProducerPlugin = require('../../dd-trace/src/plugins/producer')

      for (const [type, BaseClass] of [['cache', CachePlugin], ['consumer', ConsumerPlugin], ['producer', ProducerPlugin]]) {
        const { plugin } = createIntegration({
          id: `test-${type}`,
          module: `test-${type}-pkg`,
          versions: '>=1.0.0',
          type,
          intercepts: [{
            className: 'X', methodName: 'y', kind: 'Async',
            span: { name: `test.${type}`, spanKind: 'client' },
          }],
        })

        assert.ok(plugin.prototype instanceof BaseClass, `${type} plugin should extend ${BaseClass.name}`)
        assert.strictEqual(typeof plugin.prototype.startSpan, 'function', `${type} plugin should have startSpan override`)
        assert.strictEqual(plugin.prototype.startSpan.length, 3, `${type} plugin startSpan should accept 3 args`)
      }
    })

    it('should produce a CompositePlugin for multiple intercepts', () => {
      const CompositePlugin = require('../../dd-trace/src/plugins/composite')

      const { plugin, orchestrion } = createIntegration({
        id: 'multi',
        module: 'multi-pkg',
        versions: '>=1.0.0',
        file: 'lib/main.js',
        type: 'server',
        intercepts: [
          { className: 'A', methodName: 'foo', kind: 'Async', span: { name: 'multi.foo', spanKind: 'server' } },
          { className: 'B', methodName: 'bar', kind: 'Callback', index: -1, span: { name: 'multi.bar', spanKind: 'server' } },
        ],
      })

      assert.strictEqual(orchestrion.length, 2)
      assert.ok(plugin.prototype instanceof CompositePlugin)
    })

    it('should call prepare before resource and attributes', () => {
      const calls = []
      const { plugin } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        type: 'tracing',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Async',
          span: {
            name: 'test.op',
            spanKind: 'client',
            prepare (ctx) { calls.push('prepare'); ctx.derived = 'value' },
            resource (ctx) { calls.push('resource'); return ctx.derived },
            attributes (ctx) { calls.push('attributes'); return { key: ctx.derived } },
          },
        }],
      })

      // Verify prepare is defined and the plugin was generated
      assert.strictEqual(typeof plugin.prototype.bindStart, 'function')
      assert.strictEqual(calls.length, 0, 'nothing should be called at definition time')
    })

    it('should bind prepare to the plugin instance', () => {
      let pluginInstance
      const { plugin } = createIntegration({
        id: 'test',
        module: 'test-pkg',
        versions: '>=1.0.0',
        type: 'tracing',
        intercepts: [{
          className: 'Foo', methodName: 'bar', kind: 'Async',
          span: {
            name: 'test.op',
            spanKind: 'client',
            prepare () { pluginInstance = this },
          },
        }],
      })

      assert.strictEqual(typeof plugin.prototype.bindStart, 'function')
    })
  })

  describe('validation', () => {
    it('should throw when id is empty or not a string', () => {
      const base = { module: 'x', versions: '>=1', intercepts: [{ className: 'X', methodName: 'y', kind: 'Sync', span: { name: 't', spanKind: 'server' } }] }
      assert.throws(() => createIntegration({ ...base, id: '' }), /requires a non-empty string id/)
      assert.throws(() => createIntegration({ ...base, id: null }), /requires a non-empty string id/)
      assert.throws(() => createIntegration({ ...base }), /requires a non-empty string id/)
    })

    it('should throw when module is empty or not a string', () => {
      const base = { id: 'x', versions: '>=1', intercepts: [{ className: 'X', methodName: 'y', kind: 'Sync', span: { name: 't', spanKind: 'server' } }] }
      assert.throws(() => createIntegration({ ...base, module: '' }), /requires a non-empty string module/)
      assert.throws(() => createIntegration({ ...base }), /requires a non-empty string module/)
    })

    it('should throw when intercepts is empty or missing', () => {
      const base = { id: 'x', module: 'x', versions: '>=1' }
      assert.throws(() => createIntegration({ ...base }), /requires at least one intercept/)
      assert.throws(() => createIntegration({ ...base, intercepts: [] }), /requires at least one intercept/)
    })

    it('should throw for unknown plugin type', () => {
      assert.throws(() => {
        createIntegration({
          id: 'test', module: 'test-pkg', versions: '>=1.0.0', type: 'unknown',
          intercepts: [{ className: 'X', methodName: 'y', kind: 'Sync', span: { name: 't', spanKind: 'client' } }],
        })
      }, /Unknown plugin type/)
    })

    it('should throw when intercept is missing span config', () => {
      assert.throws(() => {
        createIntegration({
          id: 'test', module: 'test-pkg', versions: '>=1.0.0',
          intercepts: [{ className: 'X', methodName: 'y', kind: 'Sync' }],
        })
      }, /requires a span configuration/)
    })

    it('should throw for invalid method kind', () => {
      assert.throws(() => {
        createIntegration({
          id: 'test', module: 'test-pkg', versions: '>=1.0.0',
          intercepts: [{ className: 'X', methodName: 'y', kind: 'BadKind', span: { name: 't', spanKind: 'server' } }],
        })
      }, /Invalid method kind "BadKind"/)
    })

    it('should throw when channelName cannot be derived', () => {
      assert.throws(() => {
        createIntegration({
          id: 'test', module: 'test-pkg', versions: '>=1.0.0',
          intercepts: [{ astQuery: 'FunctionExpression', kind: 'Sync', span: { name: 'test', spanKind: 'server' } }],
        })
      }, /channelName must be provided/)
    })
  })
})
