const SchemaDefinition = require('../definition')
const messaging = require('./messaging')
const storage = require('./storage')
const web = require('./web')

module.exports = new SchemaDefinition({ messaging, storage, web })
