'use strict'
const { createAutoConfiguredPlugin } = require('../../dd-trace/src/plugins/declarative')

// TODO: The analysis file name should probably come from a central place
module.exports = createAutoConfiguredPlugin(__dirname, 'bullmq')
