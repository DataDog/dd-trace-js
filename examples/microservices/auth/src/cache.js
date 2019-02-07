'use strict'

const redis = require('redis')
const client = redis.createClient({ host: 'redis' })

client.on('error', () => {})
client.on('ready', () => {
  client.set('jwks', '{}')
})

module.exports = client
