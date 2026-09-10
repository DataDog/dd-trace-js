'use strict'

const Redis = require('ioredis')

module.exports = async function extensionless (_request, response) {
  const redis = new Redis()
  const value = await redis.sendCommand({
    args: ['key'],
    name: 'get',
    promise: Promise.resolve('extensionless'),
  })
  response.json({ value })
}
