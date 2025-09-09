'use strict'

const SchemaDefinition = require('../definition')
const messaging = require('./messaging')
const storage = require('./storage')
const graphql = require('./graphql')
const web = require('./web')
const serverless = require('./serverless')
const websocket = require('./websocket')

module.exports = new SchemaDefinition({ messaging, storage, web, graphql, serverless, websocket })
