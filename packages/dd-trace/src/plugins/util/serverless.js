'use strict'

const types = require('../../../../../ext/types')
const web = require('./web')

const serverless = { ...web, TYPE: types.SERVERLESS }

module.exports = serverless
