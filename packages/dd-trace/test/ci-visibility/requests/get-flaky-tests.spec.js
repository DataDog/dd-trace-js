'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const zlib = require('node:zlib')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../../setup/core')
const getConfig = require('../../../src/config')
const getFlakyTests = require('../../../src/ci-visibility/requests/get-flaky-tests')
const { buildCacheKey, getCachePath, writeToCache } = require('../../../src/ci-visibility/requests/fs-cache')

const url = 'http://localhost:8126'
const endpoint = '/api/v2/ci/libraries/tests/flaky'
const attributes = { configurations: { 'test.bundle': 'jest' }, suite: 'suite.js', name: 'test', parameters: 'ignored' }
const configuration = {
  url,
  service: 'service',
  env: 'test',
  repositoryUrl: 'https://github.com/example/repo',
  sha: 'abc123',
  branch: 'main',
  custom: { environment: 'test' },
}

describe('get flaky tests', () => {
  const cachePaths = new Set()

  function cacheKey (config) {
    const key = buildCacheKey('flaky-tests', [
      config.sha, config.branch || config.tag, config.service, config.env, config.repositoryUrl,
      config.osPlatform, config.osVersion, config.osArchitecture,
      config.runtimeName, config.runtimeVersion, config.custom,
    ])
    cachePaths.add(getCachePath(key))
    return key
  }

  beforeEach(() => {
    sinon.stub(getConfig(), 'DD_API_KEY').value('api-key')
    sinon.stub(getConfig(), 'DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE').value(false)
  })

  afterEach(() => {
    for (const path of cachePaths) fs.rmSync(path, { force: true })
    cachePaths.clear()
    nock.cleanAll()
    sinon.restore()
  })

  for (const isEvpProxy of [false, true]) {
    it(`uses the Java request contract (proxy=${isEvpProxy})`, done => {
      const path = isEvpProxy ? `/evp_proxy/v4${endpoint}` : endpoint
      const response = zlib.gzipSync(JSON.stringify({ data: [{ type: 'test', attributes }] }))
      const scope = nock(url).post(path, body => {
        assert.strictEqual(body.data.type, 'flaky_test_from_libraries_params')
        assert.strictEqual(body.data.attributes.repository_url, configuration.repositoryUrl)
        assert.strictEqual(body.data.attributes.branch, 'main')
        assert.strictEqual(body.data.attributes.sha, 'abc123')
        assert.strictEqual(body.data.attributes.test_level, 'test')
        assert.deepStrictEqual(body.data.attributes.configurations.custom, { environment: 'test' })
        return true
      }).matchHeader(isEvpProxy ? 'X-Datadog-EVP-Subdomain' : 'dd-api-key', isEvpProxy ? 'api' : 'api-key')
        .reply(200, response, { 'content-encoding': 'gzip' })

      getFlakyTests({ ...configuration, isEvpProxy, evpProxyPrefix: '/evp_proxy/v4', isGzipCompatible: true },
        (err, tests) => {
          assert.ifError(err)
          assert.ok(tests)
          assert.deepStrictEqual(tests.jest['suite.js'], ['test'])
          assert.ok(scope.isDone())
          done()
        })
    })
  }

  for (const branch of [undefined, 'main']) {
    it(`uses the tag when no branch is available (branch=${branch})`, done => {
      const scope = nock(url).post(endpoint, body => body.data.attributes.branch === (branch || 'v1.0.0'))
        .reply(200, { data: [] })
      getFlakyTests({ ...configuration, branch, tag: 'v1.0.0' }, (err) => {
        assert.ifError(err)
        assert.ok(scope.isDone())
        done()
      })
    })
  }

  it('caches tag-only requests separately for different tags', done => {
    sinon.stub(getConfig(), 'DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE').value(true)
    const first = { ...configuration, sha: `tag-cache-${process.pid}`, branch: undefined, tag: 'v1.0.0' }
    const second = { ...first, tag: 'v2.0.0' }
    // Track both the expected and old key for cleanup if the regression fails.
    for (const config of [first, second, { ...first, tag: undefined }]) cacheKey(config)
    nock(url).post(endpoint).reply(200, { data: [{ attributes }] })
    getFlakyTests(first, (err, tests) => {
      assert.ifError(err)
      assert.deepStrictEqual(tests.jest['suite.js'], ['test'])
      getFlakyTests(first, (err, cached) => {
        assert.ifError(err)
        assert.deepStrictEqual(cached.jest['suite.js'], ['test'])
        const scope = nock(url).post(endpoint).reply(200, { data: [] })
        getFlakyTests(second, (err, tests) => {
          assert.ifError(err)
          assert.deepStrictEqual(Object.keys(tests), [])
          assert.ok(scope.isDone())
          done()
        })
      })
    })
  })

  for (const data of [null, [], false, 'invalid', { jest: null }, { jest: [] },
    { jest: { 'suite.js': null } }, { jest: { 'suite.js': [123] } }]) {
    it(`rejects malformed cached identities ${JSON.stringify(data)}`, done => {
      sinon.stub(getConfig(), 'DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE').value(true)
      const config = { ...configuration, sha: `corrupt-cache-${process.pid}` }
      writeToCache(cacheKey(config), data)
      getFlakyTests(config, (err, tests) => {
        assert.ok(err)
        assert.strictEqual(tests, undefined)
        done()
      })
    })
  }

  it('accepts a cached empty list', done => {
    sinon.stub(getConfig(), 'DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE').value(true)
    const config = { ...configuration, sha: `empty-cache-${process.pid}` }
    writeToCache(cacheKey(config), {})
    getFlakyTests(config, (err, tests) => {
      assert.ifError(err)
      assert.deepStrictEqual(tests, {})
      done()
    })
  })

  it('distinguishes a valid empty response from unavailable data', done => {
    nock(url).post(endpoint).reply(200, { data: [] })
    getFlakyTests(configuration, (err, tests) => {
      assert.ifError(err)
      assert.ok(tests)
      assert.deepStrictEqual(Object.keys(tests), [])
      done()
    })
  })

  for (const response of ['bad json', {}, { data: null }, { data: [{ attributes: {} }] },
    { data: [{ attributes }, { attributes: { ...attributes, name: 123 } }] }]) {
    it(`rejects the complete malformed list ${JSON.stringify(response)}`, done => {
      nock(url).post(endpoint).reply(200, response)
      getFlakyTests(configuration, (err, tests) => {
        assert.ok(err)
        assert.strictEqual(tests, undefined)
        done()
      })
    })
  }

  it('returns HTTP failures for the caller to apply regular ATR', done => {
    nock(url).post(endpoint).reply(403)
    getFlakyTests(configuration, (err, tests) => {
      assert.ok(err)
      assert.strictEqual(tests, undefined)
      done()
    })
  })
})
