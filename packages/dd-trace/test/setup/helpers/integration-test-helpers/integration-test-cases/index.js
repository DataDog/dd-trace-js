'use strict'

const { DatabaseTestHelper } = require('./database')
const { MessagingTestHelper } = require('./messaging')
const { WebServerTestHelper } = require('./web-server')
const { WebClientTestHelper } = require('./web-client')
const { CacheTestHelper } = require('./cache')
const { CustomTestHelper } = require('./custom')

module.exports = {
  database: DatabaseTestHelper,
  messaging: MessagingTestHelper,
  'web-server': WebServerTestHelper,
  'web-client': WebClientTestHelper,
  cache: CacheTestHelper,
  custom: CustomTestHelper
}
