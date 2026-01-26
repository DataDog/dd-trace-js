'use strict'

const request = require('../exporters/common/request')

/**
 * Fetches agent information from the /info endpoint
 * @param {URL} url - The agent URL
 * @param {Function} callback - Callback function with signature (err, agentInfo)
 */
function fetchAgentInfo (url, callback) {
  request('', {
    path: '/info',
    url
  }, (err, res) => {
    if (err) {
      return callback(err)
    }
    try {
      const response = JSON.parse(res)
      return callback(null, response)
    } catch (e) {
      return callback(e)
    }
  })
}

module.exports = { fetchAgentInfo }
