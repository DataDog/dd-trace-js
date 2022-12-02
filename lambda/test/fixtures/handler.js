'use strict'
const _tracer = require('../../../packages/dd-trace')

exports.handler = async (...args) => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  await _tracer.trace('self.sleepy', async () => {
    await sleep(100)
  })

  const response = {
    statusCode: 200,
    body: JSON.stringify(
      {
        message: 'hello!'
      },
      null,
      2
    )
  }

  return response
}
