'use strict'

const path = require('path')

const { getNodeModulesPaths } = require('../path-line')
const Analyzer = require('./vulnerability-analyzer')
const { WEAK_HASH } = require('../vulnerabilities')

const INSECURE_HASH_ALGORITHMS = new Set([
  'md4', 'md4WithRSAEncryption', 'RSA-MD4',
  'RSA-MD5', 'md5', 'md5-sha1', 'ssl3-md5', 'md5WithRSAEncryption',
  'RSA-SHA1', 'RSA-SHA1-2', 'sha1', 'md5-sha1', 'sha1WithRSAEncryption', 'ssl3-sha1'
].map(algorithm => algorithm.toLowerCase()))

const EXCLUDED_LOCATIONS = getNodeModulesPaths(
  'etag/index.js',
  '@mikro-orm/core/utils/Utils.js',
  'mongodb/lib/core/connection/connection.js',
  'mysql2/lib/auth_41.js',
  'pusher/lib/utils.js',
  'redlock/dist/cjs',
  'sqreen/lib/package-reader/index.js',
  'ws/lib/websocket-server.js',
  'google-gax/build/src/grpc.js',
  'cookie-signature/index.js'
)

const EXCLUDED_PATHS_FROM_STACK = [
  path.join('node_modules', 'object-hash', path.sep),
  path.join('node_modules', 'aws-sdk', 'lib', 'util.js'),
  path.join('node_modules', 'keygrip', path.sep)
]
class WeakHashAnalyzer extends Analyzer {
  constructor () {
    super(WEAK_HASH)
  }

  onConfigure () {
    this.addSub('datadog:crypto:hashing:start', ({ algorithm }) => this.analyze(algorithm))
  }

  _isVulnerable (algorithm) {
    if (typeof algorithm === 'string') {
      return INSECURE_HASH_ALGORITHMS.has(algorithm.toLowerCase())
    }
    return false
  }

  _isExcluded (location) {
    return EXCLUDED_LOCATIONS.some(excludedLocation => {
      return location.path.includes(excludedLocation)
    })
  }

  _getExcludedPaths () {
    return EXCLUDED_PATHS_FROM_STACK
  }
}

module.exports = new WeakHashAnalyzer()
