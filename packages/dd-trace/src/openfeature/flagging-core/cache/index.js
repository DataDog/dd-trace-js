'use strict'

module.exports = {
  ...require('./abstract-assignment-cache'),
  ...require('./lru-in-memory-assignment-cache'),
  ...require('./non-expiring-in-memory-cache-assignment')
}