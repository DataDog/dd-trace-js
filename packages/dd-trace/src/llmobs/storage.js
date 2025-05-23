'use strict'

const { storage: createStorage } = require('../../../datadog-core')
const storage = createStorage('llmobs')

module.exports = { storage }
