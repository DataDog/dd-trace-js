'use strict'

const dgram = require('node:dgram')
const log = require('../../dd-trace/src/log')

const HOST = '127.0.0.1'
const PORT = 8125
const SOCKET_TYPE = 'udp4'
const TAG_RE = /[^\w\d_\-:/\.]/gu
const TAG_SUB = '_'
const MAX_FLUSH_TIMEOUT = 1000

class LambdaDogStatsD {
  constructor () {
    this._socket = dgram.createSocket(SOCKET_TYPE)
    this._socket.unref?.()
    this._pendingSends = new Set()
  }

  /**
   * @param {string} metric
   * @param {number} value
   * @param {number} [timestamp] - seconds since epoch
   * @param {string[]} [tags]
   */
  distribution (metric, value, timestamp, tags) {
    this._report(metric, 'd', value, tags, timestamp)
  }

  /**
   * Waits for all in-flight sends to complete (with timeout).
   * @param {Function} cb
   */
  flush (cb) {
    if (this._pendingSends.size === 0) {
      if (cb) cb()
      return
    }

    let done = false
    const finish = function () {
      if (done) return
      done = true
      if (cb) cb()
    }

    const timer = setTimeout(function () {
      log.debug('Timed out before sending all metric payloads')
      finish()
    }, MAX_FLUSH_TIMEOUT)
    timer.unref?.()

    let remaining = this._pendingSends.size
    for (const p of this._pendingSends) {
      p.then(function () {
        remaining--
        if (remaining <= 0) {
          clearTimeout(timer)
          finish()
        }
      })
    }
  }

  _normalizeTags (tags) {
    return tags.map(function (t) { return t.replace(TAG_RE, TAG_SUB) })
  }

  _report (metric, metricType, value, tags, timestamp) {
    if (value == null) return
    if (timestamp) timestamp = Math.floor(timestamp)

    const serializedTags = tags && tags.length ? `|#${this._normalizeTags(tags).join(',')}` : ''
    const timestampPart = timestamp != null ? `|T${timestamp}` : ''
    const payload = `${metric}:${value}|${metricType}${serializedTags}${timestampPart}`
    this._send(payload)
  }

  _send (packet) {
    const self = this
    const msg = Buffer.from(packet, 'utf8')
    const promise = new Promise(function (resolve) {
      self._socket.send(msg, PORT, HOST, function (err) {
        if (err) {
          log.debug(`Unable to send metric packet: ${err.message}`)
        }
        resolve()
      })
    })

    this._pendingSends.add(promise)
    promise.then(function () {
      self._pendingSends.delete(promise)
    })
  }
}

/**
 * Check if Datadog Extension is running (file exists at /opt/extensions/datadog-agent)
 * @returns {boolean}
 */
function isExtensionRunning () {
  try {
    require('node:fs').accessSync('/opt/extensions/datadog-agent')
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  LambdaDogStatsD,
  isExtensionRunning,
}
