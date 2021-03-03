'use strict'

const ASYNC_HOOKS = process.env.ASYNC_HOOKS && process.env.ASYNC_HOOKS.split(',')
const DURATION = process.env.DURATION || 15 // seconds
const PROMISES_PER_SECOND = process.env.PROMISES_PER_SECOND || 250000

if (ASYNC_HOOKS) {
  const { createHook } = require('async_hooks')

  const hooks = {}

  for (const hook of ASYNC_HOOKS) {
    hooks[hook] = () => {}
  }

  createHook(hooks).enable()
}

const interval = setInterval(async () => {
  const promises = []

  for (let i = 0; i < PROMISES_PER_SECOND; i++) {
    promises.push(new Promise((resolve, reject) => resolve()))
  }

  await Promise.all(promises)
}, 1000)

setTimeout(() => {
  clearInterval(interval)
}, DURATION * 1000)
