'use strict'
const Analyzer = require('./vulnerability-analyzer')

const INSECURE_HASH_ALGORITHMS = new Set([
  'md4', 'md4WithRSAEncryption', 'RSA-MD4',
  'RSA-MD5', 'md5', 'md5-sha1', 'ssl3-md5', 'md5WithRSAEncryption',
  'RSA-SHA1', 'RSA-SHA1-2', 'sha1', 'md5-sha1', 'sha1WithRSAEncryption', 'ssl3-sha1'
].map(algorithm => algorithm.toLowerCase()))

class WeakHashAnalyzer extends Analyzer {
  constructor () {
    super('WEAK_HASH_ANALYZER')
    this.addSub('datadog:crypto:hashing:start', ({ algorithm }) => this.analyze(algorithm))
  }

  _isVulnerable (algorithm) {
    if (typeof algorithm === 'string') {
      return INSECURE_HASH_ALGORITHMS.has(algorithm.toLowerCase())
    }
    return false
  }
}

module.exports = new WeakHashAnalyzer()
