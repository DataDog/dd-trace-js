const SchemaDefinition = require('../definition')
const messaging = require('./messaging')
const storage = require('./storage')
const graphql = require('./graphql')
const apolloGateway = require('./apollo-gateway')
const web = require('./web')

module.exports = new SchemaDefinition({ messaging, storage, web, graphql, 'apollo-gateway': apolloGateway })
