'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

// TODO: restore use of latest branch when it gets a matching tag
suiteTest('amqplib', 'amqp-node/amqplib', 'v0.9.0')
