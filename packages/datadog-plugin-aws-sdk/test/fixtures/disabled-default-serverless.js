'use strict'

const assert = require('node:assert/strict')

const tracer = require('../../../dd-trace')
const log = require('../../../dd-trace/src/log')

tracer.init({ plugins: false, flushInterval: 0 })
tracer.use('aws-sdk')

let loggedError = false
log.error = () => { loggedError = true }

const Client = require('../../../../versions/@aws-sdk/smithy-client@3').get().Client
class STSClient extends Client {}

class GetCallerIdentityCommand {
  constructor () {
    this.input = {}
  }

  resolveMiddleware () {
    return () => Promise.resolve({ output: { Account: '123456789012' } })
  }
}

const client = new STSClient({
  region: () => Promise.resolve('us-east-1'),
  requestHandler: {},
  serviceId: 'STS',
})

async function main () {
  const response = await client.send(new GetCallerIdentityCommand())
  assert.deepStrictEqual(response, { Account: '123456789012' })
  assert.strictEqual(loggedError, false)
}

main().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
