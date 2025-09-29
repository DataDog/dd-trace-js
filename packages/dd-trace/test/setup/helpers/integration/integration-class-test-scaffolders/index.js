'use strict'

const { DatabaseTestHelper } = require('./database-helper')
const { MessagingTestHelper } = require('./messaging-helper')
const { WebServerTestHelper } = require('./web-server-helper')

module.exports = {
  database: DatabaseTestHelper,
  messaging: MessagingTestHelper,
  web: WebServerTestHelper
}
