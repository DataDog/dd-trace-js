'use strict'

const { b } = require('./module-b')

module.exports.a = () => { return 'Called by AJ' }
module.exports.b = () => { b() }
