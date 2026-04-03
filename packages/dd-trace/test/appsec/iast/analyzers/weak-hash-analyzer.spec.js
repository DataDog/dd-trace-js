'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { before, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const weakHashAnalyzer = require('../../../../src/appsec/iast/analyzers/weak-hash-analyzer')
const { prepareTestServerForIast, testOutsideRequestHasVulnerability } = require('../utils')

describe('weak-hash-analyzer', () => {
  const VULNERABLE_ALGORITHM = 'sha1'
  const NON_VULNERABLE_ALGORITHM = 'sha512'

  weakHashAnalyzer.configure(true)

  it('should subscribe to crypto hashing channel', () => {
    assert.strictEqual(weakHashAnalyzer._subscriptions.length, 1)
    assert.strictEqual(weakHashAnalyzer._subscriptions[0]._channel.name, 'datadog:crypto:hashing:start')
  })

  it('should not detect vulnerability when no algorithm', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable()
    assert.strictEqual(isVulnerable, false)
  })

  it('should not detect vulnerability when no vulnerable algorithm', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable(NON_VULNERABLE_ALGORITHM)
    assert.strictEqual(isVulnerable, false)
  })

  it('should detect vulnerability with different casing in algorithm word', () => {
    const isVulnerable = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM)
    const isVulnerableInLowerCase = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM.toLowerCase())
    const isVulnerableInUpperCase = weakHashAnalyzer._isVulnerable(VULNERABLE_ALGORITHM.toUpperCase())
    assert.strictEqual(isVulnerable, true)
    assert.strictEqual(isVulnerableInLowerCase, true)
    assert.strictEqual(isVulnerableInUpperCase, true)
  })

  it('should report "WEAK_HASH" vulnerability', () => {
    const addVulnerability = sinon.stub()
    const iastContext = {
      rootSpan: {
        context () {
          return {
            toSpanId () {
              return '123'
            },
          }
        },
      },
    }
    const ProxyAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/vulnerability-analyzer', {
      '../iast-context': {
        getIastContext: () => iastContext,
      },
      '../overhead-controller': { hasQuota: () => true },
      '../vulnerability-reporter': { addVulnerability },
    })
    const proxiedWeakHashAnalyzer = proxyquire('../../../../src/appsec/iast/analyzers/weak-hash-analyzer',
      {
        './vulnerability-analyzer': ProxyAnalyzer,
      })
    proxiedWeakHashAnalyzer.analyze(VULNERABLE_ALGORITHM)
    sinon.assert.calledOnce(addVulnerability)
    sinon.assert.calledWithMatch(addVulnerability, {}, { type: 'WEAK_HASH' })
  })

  describe('some locations should be excluded', () => {
    let locationPrefix

    before(() => {
      if (process.platform === 'win32') {
        locationPrefix = 'C:\\path\\to\\project'
      } else {
        locationPrefix = '/path/to/project'
      }
    })

    it('redlock', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'redlock', 'dist', 'cjs'),
        line: 183,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('etag', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'etag', 'index.js'),
        line: 47,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('websocket-server', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'ws', 'lib', 'websocket-server.js'),
        line: 371,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('mysql 41 authentication mechanism', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'mysql2', 'lib', 'auth_41.js'),
        line: 30,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('@micro-orm hash for keys', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', '@mikro-orm', 'core', 'utils', 'Utils.js'),
        line: 30,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('mongodb host address hash', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'mongodb', 'lib', 'core', 'connection', 'connection.js'),
        line: 137,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('sqreen package list fingerprint', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'sqreen', 'lib', 'package-reader', 'index.js'),
        line: 135,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('pusher request body fingerprint', () => {
      const location = {
        path: path.join(locationPrefix, 'node_modules', 'pusher', 'lib', 'utils.js'),
        line: 23,
      }
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), true)
    })

    it('undefined location', () => {
      const location = undefined
      assert.strictEqual(weakHashAnalyzer._isExcluded(location), false)
    })
  })

  describe('full feature', () => {
    prepareTestServerForIast('inside request', (testThatRequestHasVulnerability) => {
      testThatRequestHasVulnerability(() => {
        const crypto = require('crypto')
        crypto.createHash(VULNERABLE_ALGORITHM)
      }, 'WEAK_HASH')
    })

    describe('outside request', () => {
      testOutsideRequestHasVulnerability(() => {
        const crypto = require('crypto')
        crypto.createHash(VULNERABLE_ALGORITHM)
      }, 'WEAK_HASH')
    })
  })
})
