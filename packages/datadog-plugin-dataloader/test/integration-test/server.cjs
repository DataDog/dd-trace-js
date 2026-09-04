'use strict'

/* eslint-disable n/no-missing-require */

require('dd-trace/init')

const DataLoader = require('dataloader')

const loader = new DataLoader(keys => Promise.resolve(keys), { name: 'cjs-users' })

async function run () {
  await loader.load('key')
  await new Promise(resolve => setImmediate(resolve))
}

run().catch(error => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
