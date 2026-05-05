'use strict'

const { addHook } = require('./helpers/instrument')

addHook({ name: '@aws/durable-execution-sdk-js', versions: ['>=1.1.0'] }, exports => exports)
