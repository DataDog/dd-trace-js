'use strict'

const os = require('os')
const path = require('path')

const sandbox = path.join(os.tmpdir(), 'dd-trace', 'package')
const local = '../../..'

module.exports = require(process.env.USE_SANDBOX === 'true' ? sandbox : local)
