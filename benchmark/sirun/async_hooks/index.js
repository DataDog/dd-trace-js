'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const ASYNC_HOOKS = process.env.ASYNC_HOOKS && process.env.ASYNC_HOOKS.split(',')
const INTERVALS = Number(process.env.INTERVALS) || 10
const OPERATIONS = Number(process.env.OPERATIONS)

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
  let promisesRun = 0

  while (promisesRun < OPERATIONS) {
    const promises = []
    const intervalsLeft = INTERVALS - intervalsRun
    const remaining = OPERATIONS - promisesRun
    const promisesThisInterval = intervalsLeft > 1 ? Math.ceil(remaining / intervalsLeft) : remaining

    for (let i = 0; i < promisesThisInterval; i++) {
      promises.push(new Promise((resolve) => resolve()))
    }

    await Promise.all(promises)

    intervalsRun++
    promisesRun += promisesThisInterval
  }

  assert.equal(promisesRun, OPERATIONS, 'async_hooks bench did not create all promises')
  guard.done()
}

guard.loopStart()
run()
