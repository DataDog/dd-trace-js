'use strict'

const { storage } = require('../../../../../datadog-core')
const { IAST_CONTEXT_KEY } = require('./../index')
const Analyzer = require('./vulnerability-analyzer')

const INSECURE_HASH_ALGORITHMS = [
  'md4', 'md4WithRSAEncryption', 'RSA-MD4',
  'RSA-MD5', 'md5', 'md5-sha1', 'ssl3-md5', 'md5WithRSAEncryption',
  'RSA-SHA1', 'RSA-SHA1-2', 'sha1', 'md5-sha1', 'sha1WithRSAEncryption', 'ssl3-sha1'
].map(algorithm => algorithm.toLowerCase())

class WeakHashAnalyzer extends Analyzer {
  constructor () {
    super('WEAK_HASH_ANALYZER')
    this.addSub('asm:crypto:hashing:start', (data) => this._handler(data))
  }

  _handler ({ algorithm }) {
    const store = storage.getStore()
    if (store && store[IAST_CONTEXT_KEY]) {
      this.analyze(algorithm, store[IAST_CONTEXT_KEY])
    }
  }

  _isVulnerable (algorithm) {
    if (algorithm && typeof algorithm === 'string') {
      return INSECURE_HASH_ALGORITHMS.indexOf(algorithm.toLowerCase()) !== -1
    }
    return false
  }
}

module.exports = new WeakHashAnalyzer()
