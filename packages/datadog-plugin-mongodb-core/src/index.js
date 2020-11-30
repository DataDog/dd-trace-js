'use strict'

const unified = require('./unified')
const legacy = require('./legacy')

module.exports = [].concat(unified, legacy)
