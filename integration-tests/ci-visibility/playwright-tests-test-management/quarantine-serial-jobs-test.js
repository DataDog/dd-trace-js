'use strict'

const { test, expect } = require('@playwright/test')

const firstJob = test.extend({ workerValue: ['first', { scope: 'worker' }] })
const secondJob = test.extend({ workerValue: ['second', { scope: 'worker' }] })

test.describe.serial('quarantine separate jobs', () => {
  firstJob('quarantined failure', async ({ workerValue }) => {
    expect(workerValue).toBe('unexpected')
  })

  firstJob('did not run after failure', async () => {})

  secondJob('queued in another job', async ({ workerValue }) => {
    expect(workerValue).toBe('second')
  })
})
