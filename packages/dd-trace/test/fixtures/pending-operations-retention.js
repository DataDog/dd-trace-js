'use strict'

const PendingOperations = require('../../src/exporters/common/pending-operations')

const operations = new PendingOperations()
globalThis.operations = operations
operations.start()

global.gc()
const baseline = process.memoryUsage().heapUsed
if (process.argv[2] === 'completions') {
  for (let index = 0; index < 500_000; index++) operations.start()()
} else {
  operations.wait(() => {})
  for (let index = 0; index < 500_000; index++) operations.wait(() => {})()
}
global.gc()

process.stdout.write(String(process.memoryUsage().heapUsed - baseline))
