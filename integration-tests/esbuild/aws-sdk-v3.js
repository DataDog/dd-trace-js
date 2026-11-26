'use strict'

require('../../').init() // dd-trace

const { SQSClient } = require('@aws-sdk/client-sqs')

// Constructing a client fails when the bundle holds two copies of `@smithy/core/client`.
const client = new SQSClient({ region: 'us-east-1' })
if (!client) throw new Error('client was not created')
