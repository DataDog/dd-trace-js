'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('DatabasePlugin DBM Hash', () => {
  let DatabasePlugin
  let plugin
  let span
  let propagationHash
  let tracer

  beforeEach(() => {
    // Mock propagation hash module
    propagationHash = {
      isEnabled: () => true,
      getHashBase64: () => 'AQIDBAUG',
    }

    // Load DatabasePlugin with mocked propagation hash
    DatabasePlugin = proxyquire('../../src/plugins/database', {
      '../propagation-hash': propagationHash,
    })

    // Create a mock tracer
    tracer = {
      _service: 'test-service',
      _env: 'test',
      _version: '1.0.0',
    }

    // Create a mock span
    span = {
      context: () => ({
        _tags: {
          'out.host': 'localhost',
          'db.name': 'testdb',
        },
      }),
      _spanContext: {
        _tags: {
          'out.host': 'localhost',
          'db.name': 'testdb',
        },
        toTraceparent: () => 'traceparent-value',
      },
      setTag: function (key, value) {
        this._tags = this._tags || {}
        this._tags[key] = value
      },
      _tags: {},
      _processor: {
        sample: () => {},
      },
    }

    // Create plugin instance with proper config structure
    const config = {
      dbmPropagationMode: 'service',
      'dbm.injectSqlBaseHash': true,
    }
    plugin = new DatabasePlugin({ tracer }, config)
    plugin.config = config
    plugin._tracerConfig = {}
  })

  describe('createDbmComment with process tags', () => {
    it('should include base64 hash in SQL comment', () => {
      const comment = plugin.createDbmComment(span, 'test-service')

      assert.ok(comment, 'Comment should be created')
      assert.ok(comment.includes("ddsh='AQIDBAUG'"), 'Comment should include base64 hash')
    })

    it('should set _dd.dbm.propagation_hash tag on span', () => {
      plugin.createDbmComment(span, 'test-service')

      assert.strictEqual(span._tags['_dd.dbm.propagation_hash'], 'AQIDBAUG',
        'Span should have propagation hash tag')
    })

    it('should include hash in both service and full modes', () => {
      // Test service mode
      plugin.config.dbmPropagationMode = 'service'
      const serviceComment = plugin.createDbmComment(span, 'test-service')
      assert.ok(serviceComment.includes("ddsh='AQIDBAUG'"), 'Service mode should include hash')

      // Reset span tags
      span._tags = {}

      // Test full mode
      plugin.config.dbmPropagationMode = 'full'
      const fullComment = plugin.createDbmComment(span, 'test-service')
      assert.ok(fullComment.includes("ddsh='AQIDBAUG'"), 'Full mode should include hash')
      assert.strictEqual(span._tags['_dd.dbm.propagation_hash'], 'AQIDBAUG',
        'Full mode should set span tag')
    })

    it('should not include hash when propagation hash is disabled', () => {
      propagationHash.isEnabled = () => false

      const comment = plugin.createDbmComment(span, 'test-service')

      assert.ok(comment, 'Comment should still be created')
      assert.ok(!comment.includes('ddsh='), 'Comment should not include hash')
      assert.strictEqual(span._tags['_dd.dbm.propagation_hash'], undefined,
        'Span should not have hash tag')
    })

    it('should not include hash when getHashBase64 returns null', () => {
      propagationHash.getHashBase64 = () => null

      const comment = plugin.createDbmComment(span, 'test-service')

      assert.ok(comment, 'Comment should still be created')
      assert.ok(!comment.includes('ddsh='), 'Comment should not include hash')
    })

    it('should not include hash when dbm.injectSqlBaseHash is disabled', () => {
      plugin.config['dbm.injectSqlBaseHash'] = false

      const comment = plugin.createDbmComment(span, 'test-service')

      assert.ok(comment, 'Comment should still be created')
      assert.ok(!comment.includes('ddsh='), 'Comment should not include hash when config is disabled')
      assert.strictEqual(span._tags['_dd.dbm.propagation_hash'], undefined,
        'Span should not have hash tag when config is disabled')
    })

    it('should include hash in the correct position in comment', () => {
      const comment = plugin.createDbmComment(span, 'test-service')

      // The hash should come after service propagation tags
      assert.ok(comment.includes('dddb='), 'Comment should have dddb')
      assert.ok(comment.includes('dddbs='), 'Comment should have dddbs')
      assert.ok(comment.includes("ddsh='AQIDBAUG'"), 'Comment should have ddsh')

      // Verify it's in the format we expect
      const hashMatch = comment.match(/ddsh='([^']+)'/)
      assert.ok(hashMatch, 'Hash should be in correct format')
      assert.strictEqual(hashMatch[1], 'AQIDBAUG', 'Hash value should be base64')
    })
  })

  describe('injectDbmQuery with process tags', () => {
    it('should inject comment with hash into query', () => {
      const query = 'SELECT * FROM users'
      const injectedQuery = plugin.injectDbmQuery(span, query, 'test-service')

      assert.ok(injectedQuery.includes("ddsh='AQIDBAUG'"), 'Injected query should include hash')
      assert.ok(injectedQuery.includes(query), 'Injected query should include original query')
    })

    it('should set span tag when injecting query', () => {
      const query = 'SELECT * FROM users'
      plugin.injectDbmQuery(span, query, 'test-service')

      assert.strictEqual(span._tags['_dd.dbm.propagation_hash'], 'AQIDBAUG',
        'Span should have hash tag after query injection')
    })
  })
})
