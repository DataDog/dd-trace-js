'use strict'

function executeSearch (client, base, filter) {
  return client.search(base, filter)
}

module.exports = { executeSearch }
