'use strict'

const now = () => window.performance.now()
const loadNs = now()
const loadMs = Date.now()

module.exports = () => loadMs + now() - loadNs
