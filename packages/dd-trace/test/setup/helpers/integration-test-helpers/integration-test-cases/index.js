'use strict'

const { DatabaseTestHelper } = require('./database')
const { MessagingTestHelper } = require('./messaging')
const { WebServerTestHelper } = require('./web-server')

module.exports = {
    database: DatabaseTestHelper,
    messaging: MessagingTestHelper,
    web: WebServerTestHelper
}