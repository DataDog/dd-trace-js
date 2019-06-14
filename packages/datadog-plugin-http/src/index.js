'use strict'

const client = require('./client')
const server = require('./server')

module.exports = [].concat(client, server)
