'use strict'

const { addHook } = require('./helpers/instrument')

addHook({ name: '@openai/agents', versions: ['>=0.8.2'] }, exports => exports)
