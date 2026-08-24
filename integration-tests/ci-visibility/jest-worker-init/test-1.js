'use strict'

const { fork } = require('node:child_process')
const { once } = require('node:events')
const path = require('node:path')
const { Worker } = require('node:worker_threads')

test('runs the first suite', () => {
  expect(1 + 1).toBe(2)
})

test('loads the tracer in a user child with inherited Jest state', async () => {
  const child = fork(path.join(__dirname, 'user-child.js'), {
    env: {
      ...process.env,
      DD_TEST_JEST_WORKER_OUTPUT: '',
    },
    silent: true,
  })
  const exitPromise = once(child, 'exit')

  try {
    const [message] = await once(child, 'message')
    expect(message).toEqual({
      messageListenerCount: 0,
      tracerLoaded: true,
    })
    await exitPromise
  } finally {
    if (child.exitCode === null) child.kill()
    await exitPromise
  }
})

test('loads the tracer in a user worker thread with inherited Jest state', async () => {
  const worker = new Worker(path.join(__dirname, 'user-worker.js'), {
    env: {
      ...process.env,
      DD_TEST_JEST_WORKER_OUTPUT: '',
    },
  })

  try {
    const [[message]] = await Promise.all([
      once(worker, 'message'),
      once(worker, 'exit'),
    ])
    expect(message).toEqual({
      hasJestWorkerThreadArgument: false,
      tracerLoaded: true,
    })
  } finally {
    if (worker.threadId !== -1) await worker.terminate()
  }
})
