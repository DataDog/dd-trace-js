'use strict'

const express = require('express')
const Redis = require('ioredis')

const app = express()
app.use(async (_request, response) => {
  const redis = new Redis()
  const value = await redis.sendCommand({
    args: ['key'],
    name: 'get',
    promise: Promise.resolve('extensionless'),
  })
  response.json({ value })
})

module.exports = (request, response) => app(request, response)
