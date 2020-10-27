'use strict'

const lambda = {}

lambda['invoke'] = {
  FunctionName: 'FUNCTION_NAME',
  ClientContext: Buffer.from('{"Custom":{"foo":"bar"}}', 'base64').toString(),
  Payload: '{}'
}

module.exports = lambda
