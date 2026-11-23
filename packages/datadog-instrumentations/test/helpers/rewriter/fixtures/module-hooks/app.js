'use strict'

/* eslint n/no-extraneous-require: ['error', { allowModules: ['bullmq', 'postgres'] }] */

const dc = require('dc-polyfill')

/** @type {Record<string, string[]>} */
const rewrites = { bullmq: [], postgres: [] }
dc.channel('dd-trace:instrumentation:load:orchestrion').subscribe(({ moduleName, result }) => {
  rewrites[moduleName]?.push(result)
})

require('bullmq')
// An ES module loaded through require(): Module._compile never sees the files it imports.
require('postgres')

process.stdout.write(JSON.stringify({ commonjs: rewrites.bullmq, postgres: rewrites.postgres }))
