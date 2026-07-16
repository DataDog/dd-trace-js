'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const ElasticsearchPlugin = require('../src')
const OpenSearchPlugin = require('../../datadog-plugin-opensearch/src')

/**
 * Drive `bindStart` with a controlled `ctx` and capture the `meta` object
 * `startSpan` would have received. Avoids the real tracer / ES client so the
 * four logical permutations of the params gate can be pinned in isolation.
 *
 * @param {typeof ElasticsearchPlugin} PluginCtor
 */
function captureMeta (PluginCtor, params) {
  const plugin = new PluginCtor({}, {})
  let meta
  plugin.serviceName = () => 'svc'
  plugin.operationName = () => 'op'
  plugin.startSpan = (_name, options) => { meta = options.meta }
  plugin.bindStart({ params })
  return meta
}

describe('ElasticsearchPlugin params meta tag', () => {
  it('tags from params.querystring when it is a non-empty object', () => {
    const meta = captureMeta(ElasticsearchPlugin, {
      path: '/docs/_search',
      method: 'POST',
      querystring: { sort: 'name', size: 100 },
    })
    assert.strictEqual(meta['elasticsearch.params'], '{"sort":"name","size":100}')
  })

  it('falls back to params.query when querystring is absent', () => {
    const meta = captureMeta(ElasticsearchPlugin, {
      path: '/docs/_search',
      method: 'POST',
      query: { from: 0, size: 10 },
    })
    assert.strictEqual(meta['elasticsearch.params'], '{"from":0,"size":10}')
  })

  it('sends the params tag even when querystring is an empty object', () => {
    const meta = captureMeta(ElasticsearchPlugin, {
      path: '/_cluster/health',
      method: 'GET',
      querystring: {},
    })
    assert.strictEqual(meta['elasticsearch.params'], '{}')
  })

  it('skips the params tag when both querystring and query are absent', () => {
    const meta = captureMeta(ElasticsearchPlugin, {
      path: '/',
      method: 'HEAD',
    })
    assert.ok(!('elasticsearch.params' in meta))
  })

  it('uses the opensearch.* prefix on the OpenSearchPlugin subclass', () => {
    const meta = captureMeta(OpenSearchPlugin, {
      path: '/docs/_search',
      method: 'POST',
      querystring: { sort: 'name' },
    })
    assert.strictEqual(meta['opensearch.params'], '{"sort":"name"}')
  })
})
