'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const DatabasePlugin = require('../../src/plugins/database')
const MongodbCoreQueryPlugin = require('../../../datadog-plugin-mongodb-core/src/query')

const CONFIGURED_SERVICE = 'postgres.db'

function makeSpan (tags = {}) {
  return {
    context: () => ({
      _tags: tags,
      getTag: (key) => tags[key],
      getTags: () => tags,
      setTag: (key, value) => { tags[key] = value },
      hasTag: (key) => Object.hasOwn(tags, key),
    }),
    setTag () {},
    _spanContext: { toTraceparent: () => '00-aaa-bbb-01' },
    _processor: { sample () {} },
  }
}

/**
 * Build a plugin wired to the real `getPeerService` implementation so the peer data under test is
 * the peer data the SQL comment path actually sees.
 *
 * @param {{ spanComputePeerService?: boolean, peerServiceMapping?: object }} tracerConfig
 * @param {typeof DatabasePlugin} Plugin
 */
function buildPlugin ({ spanComputePeerService = false, peerServiceMapping } = {}, Plugin = DatabasePlugin) {
  const tracer = { _service: 'orders-api', _env: 'prod', _version: '1.0.0' }
  const plugin = new Plugin(tracer, { spanComputePeerService, peerServiceMapping })
  plugin.configure({ dbmPropagationMode: 'service', enabled: true })
  return plugin
}

function getField (comment, key) {
  return new RegExp(`${key}='([^']*)'`).exec(comment)?.[1]
}

describe('DatabasePlugin DBM comment', () => {
  describe('dddbs', () => {
    it('uses the configured database service when the peer service is computed from db.name', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'dddbs'), CONFIGURED_SERVICE)
    })

    it('uses the configured database service when the peer service is computed from out.host', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(makeSpan({ 'out.host': 'db.internal' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'dddbs'), CONFIGURED_SERVICE)
    })

    it('uses the configured database service when an explicit peer.service is set', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal', 'peer.service': 'postgres-prod' }),
        CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'dddbs'), CONFIGURED_SERVICE)
    })

    it('uses the configured database service when the peer service is remapped', () => {
      const plugin = buildPlugin({
        spanComputePeerService: true,
        peerServiceMapping: { 'postgres-prod': 'pg-mapped' },
      })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal', 'peer.service': 'postgres-prod' }),
        CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'dddbs'), CONFIGURED_SERVICE)
    })
  })

  describe('ddprs', () => {
    it('is omitted for a peer service computed from db.name', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), undefined)
    })

    it('is omitted for a peer service computed from out.host', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(makeSpan({ 'out.host': 'db.internal' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), undefined)
    })

    it('is omitted when computation is disabled and no peer.service is set', () => {
      const plugin = buildPlugin({ spanComputePeerService: false })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), undefined)
    })

    it('carries an explicitly-set peer.service', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal', 'peer.service': 'postgres-prod' }),
        CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), 'postgres-prod')
    })

    it('carries an explicitly-set peer.service when computation is disabled', () => {
      const plugin = buildPlugin({ spanComputePeerService: false })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal', 'peer.service': 'postgres-prod' }),
        CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), 'postgres-prod')
    })

    it('carries the raw peer.service even when a mapping matches', () => {
      const plugin = buildPlugin({
        spanComputePeerService: true,
        peerServiceMapping: { 'postgres-prod': 'pg-mapped' },
      })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'out.host': 'db.internal', 'peer.service': 'postgres-prod' }),
        CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), 'postgres-prod')
    })

    it('is omitted when peer.service is an empty string', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb', 'peer.service': '' }), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), undefined)
    })

    it('is omitted when the span has no peer service precursor', () => {
      const plugin = buildPlugin({ spanComputePeerService: true })

      const comment = plugin.createDbmComment(makeSpan(), CONFIGURED_SERVICE)

      assert.strictEqual(getField(comment, 'ddprs'), undefined)
    })
  })

  // mongodb-core derives its own peer service from `db.name` (collection-stripped) and writes it
  // into the span tags, so it reports `_dd.peer.service.source` as `peer.service` even though the
  // value was computed. Drive the real plugin so that quirk cannot leak back into `dddbs`.
  describe('mongodb-core collection-stripped peer service', () => {
    it('keeps the configured database service while reporting the derived peer service in ddprs', () => {
      const plugin = buildPlugin({ spanComputePeerService: true }, MongodbCoreQueryPlugin)

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb.users', 'out.host': 'mongo.internal' }), 'mongo-db-service')

      assert.strictEqual(getField(comment, 'dddbs'), 'mongo-db-service')
      assert.strictEqual(getField(comment, 'ddprs'), 'ordersdb')
    })

    it('keeps the configured database service when peer-service computation is disabled', () => {
      const plugin = buildPlugin({ spanComputePeerService: false }, MongodbCoreQueryPlugin)

      const comment = plugin.createDbmComment(
        makeSpan({ 'db.name': 'ordersdb.users', 'out.host': 'mongo.internal' }), 'mongo-db-service')

      assert.strictEqual(getField(comment, 'dddbs'), 'mongo-db-service')
      assert.strictEqual(getField(comment, 'ddprs'), 'ordersdb')
    })
  })
})
