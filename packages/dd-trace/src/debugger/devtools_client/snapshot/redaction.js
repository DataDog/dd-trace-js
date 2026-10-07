'use strict'

const config = require('../config')
const { createIsRedactedIdentifier } = require('../../redaction')

module.exports = {
  isRedactedIdentifier: createIsRedactedIdentifier(config.dynamicInstrumentation),
}
