'use strict'

const loadNs = performance.now()
const loadMs = Date.now()

module.exports = () => loadMs + performance.now() - loadNs
