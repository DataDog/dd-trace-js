'use strict'

const crypto = require('node:crypto')
const log = require('../log')

const MAX_SIZE = 4096
const DEFAULT_DELAY = 30 // 30s

class ApiSecuritySamplerCache extends Map {
  constructor (delay) {
    super()
    this.delay = this._parseSampleDelay(delay)
  }

  _parseSampleDelay (delay) {
    if (typeof delay === 'number' && Number.isFinite(delay) && delay > 0) {
      return delay
    } else {
      log.warn('Invalid delay value. Delay must be a positive number.')
      return DEFAULT_DELAY
    }
  }

  computeKey (req, res) {
    const route = req.url
    const method = req.method.toLowerCase()
    const statusCode = res.statusCode
    const str = route + statusCode + method
    return crypto.createHash('md5').update(str).digest('hex')
  }

  isSampled (key) {
    if (!super.has(key)) {
      return false
    }
    const previous = super.get(key)
    return Date.now() - previous < (this.delay * 1000)
  }

  set (key) {
    if (super.has(key)) {
      super.delete(key)
    }

    super.set(key, Date.now())
    if (super.size > MAX_SIZE) {
      const oldestKey = super.keys().next().value
      super.delete(oldestKey)
    }
  }
}

module.exports = ApiSecuritySamplerCache
