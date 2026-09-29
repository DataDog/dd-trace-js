'use strict'

const assert = require('node:assert/strict')
const zlib = require('node:zlib')

const { describe, it, beforeEach, afterEach } = require('mocha')
const nock = require('nock')
const sinon = require('sinon')

require('../../setup/core')
const getConfig = require('../../../src/config')
const getFlakyTests = require('../../../src/ci-visibility/requests/get-flaky-tests')

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
  beforeEach(() => {
    sinon.stub(getConfig(), 'DD_API_KEY').value('api-key')
    sinon.stub(getConfig(), 'DD_EXPERIMENTAL_TEST_REQUESTS_FS_CACHE').value(false)
  })

  afterEach(() => {
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
