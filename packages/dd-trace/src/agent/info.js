'use strict'

const request = require('../exporters/common/request')

const CACHE_TTL_MS = 60_000 // 1 minute

let cachedUrl = null
let cachedData = null
let cachedTimestamp = 0

module.exports = {
  fetchAgentInfo,
  clearCache, // For testing purposes only
}

/**
 * Fetches agent information from the /info endpoint
 * @param {URL} url - The agent URL
 * @param {Function} callback - Callback function with signature (err, agentInfo)
 */
function fetchAgentInfo (url, callback) {
  const urlKey = url.href

  if (cachedUrl !== null && cachedUrl !== urlKey) {
    // Clear cache if URL changes
    clearCache()
  } else if (cachedData !== null && (Date.now() - cachedTimestamp) < CACHE_TTL_MS) {
    // Return cached result if still valid
    return process.nextTick(callback, null, cachedData)
  }

  request('', {
    path: '/info',
    url,
  }, (err, res) => {
    if (err) {
      return callback(err)
    }

    try {
      cachedData = JSON.parse(res)
    } catch (e) {
      return callback(e)
    }

    cachedUrl = urlKey
    cachedTimestamp = Date.now()

    callback(null, cachedData)
  })
}

function clearCache () {
  cachedUrl = null
  cachedData = null
  cachedTimestamp = 0
}
