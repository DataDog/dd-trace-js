'use strict'

const { appendFileSync } = require('node:fs')

const { Then } = require('@cucumber/cucumber')

Then('it fails', function () {
  appendFileSync(process.env.WORKER_PAYLOADS_FILE, JSON.stringify({
    workerId: process.env.CUCUMBER_WORKER_ID,
    flakyTests: this.parameters._ddFlakyTests,
  }) + '\n')
  throw new Error('failure')
})
