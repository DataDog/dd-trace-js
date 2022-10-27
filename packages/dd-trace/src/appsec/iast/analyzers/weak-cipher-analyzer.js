'use strict'
const Analyzer = require('./vulnerability-analyzer')

const INSECURE_CIPHERS = new Set([
  'des', 'des-cbc', 'des-cfb', 'des-cfb1', 'des-cfb8', 'des-ecb', 'des-ede', 'des-ede-cbc', 'des-ede-cfb',
  'des-ede-ecb', 'des-ede-ofb', 'des-ede3', 'des-ede3-cbc', 'des-ede3-cfb', 'des-ede3-cfb1', 'des-ede3-cfb8',
  'des-ede3-ecb', 'des-ede3-ofb', 'des-ofb', 'des3', 'des3-wrap',
  'rc2', 'rc2-128', 'rc2-40', 'rc2-40-cbc', 'rc2-64', 'rc2-64-cbc', 'rc2-cbc', 'rc2-cfb', 'rc2-ecb', 'rc2-ofb',
  'blowfish',
  'rc4', 'rc4-40', 'rc4-hmac-md5'
].map(algorithm => algorithm.toLowerCase()))

class WeakCipherAnalyzer extends Analyzer {
  constructor () {
    super('WEAK_CIPHER')
    this.addSub('datadog:crypto:cipher:start', ({ algorithm }) => this.analyze(algorithm))
  }

  _isVulnerable (algorithm) {
    if (algorithm && typeof algorithm === 'string') {
      return INSECURE_CIPHERS.has(algorithm.toLowerCase())
    }
    return false
  }
}

module.exports = new WeakCipherAnalyzer()
