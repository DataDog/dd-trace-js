'use strict'

const assert = require('node:assert/strict')

const ASYNC_HOOKS = process.env.ASYNC_HOOKS && process.env.ASYNC_HOOKS.split(',')
const PROMISES_PER_INTERVAL = Number(process.env.PROMISES_PER_INTERVAL) || 100000
const INTERVALS = Number(process.env.INTERVALS) || 10

if (ASYNC_HOOKS) {
  const { createHook } = require('async_hooks')

  const hooks = {}

  for (const hook of ASYNC_HOOKS) {
    hooks[hook] = () => {}
  }

  createHook(hooks).enable()
}

// Each interval allocates and resolves a burst of promises so the enabled hooks
// fire across the full promise lifecycle. Bursts run back-to-back: awaiting each
// batch drains the microtask queue and lets the previous array be collected, so
// live memory stays flat without an idle timer between bursts (idle time would
// add scheduler variance while measuring nothing).
async function run () {
  let intervalsRun = 0

  while (intervalsRun < INTERVALS) {
    const promises = []

    for (let i = 0; i < PROMISES_PER_INTERVAL; i++) {
      promises.push(new Promise((resolve) => resolve()))
    }

    await Promise.all(promises)

    intervalsRun++
  }

  assert.equal(intervalsRun, INTERVALS, 'async_hooks bench did not run all intervals')
}

run()
