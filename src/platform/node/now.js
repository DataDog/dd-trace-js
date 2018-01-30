'use strict'

const now = require('performance-now')
const loadNs = now()
const loadMs = Date.now()

module.exports = () => loadMs + now() - loadNs
