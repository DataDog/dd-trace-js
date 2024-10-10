const types = require('../../../../../ext/types')
const web = require('./web')

const serverless = { ...web }
serverless.TYPE = types.SERVERLESS

module.exports = serverless
