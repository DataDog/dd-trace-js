'use strict'

// TODO: support https://moleculer.services/docs/0.13/actions.html#Streaming

const client = require('./client')
const server = require('./server')

module.exports = [].concat(client, server)
