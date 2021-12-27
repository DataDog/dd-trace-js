'use strict'

const ASYNC_HOOKS = process.env.ASYNC_HOOKS && process.env.ASYNC_HOOKS.split(',')
const PROMISES_PER_INTERVAL = process.env.PROMISES_PER_INTERVAL || 100000
const INTERVALS = process.env.INTERVALS || 10

if (ASYNC_HOOKS) {
  const { createHook } = require('async_hooks')

  const hooks = {}

  for (const hook of ASYNC_HOOKS) {
    hooks[hook] = () => {}
  }

  createHook(hooks).enable()
}

async function run (count = 0) {
  if (count >= INTERVALS) return

  const promises = []

  for (let i = 0; i < PROMISES_PER_INTERVAL; i++) {
    promises.push(new Promise((resolve, reject) => resolve()))
  }

  await Promise.all(promises)

  count++

  setTimeout(() => run(count + 1), 100)
}

run()
