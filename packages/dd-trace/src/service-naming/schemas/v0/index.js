const SchemaDefinition = require('../definition')
const messaging = require('./messaging')
const storage = require('./storage')

module.exports = new SchemaDefinition({ messaging, storage })
