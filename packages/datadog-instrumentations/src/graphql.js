'use strict'

const {
    addHook,
    channel,
    AsyncResource
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')

