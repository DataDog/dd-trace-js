import { Worker, isMainThread } from 'node:worker_threads'
import { URL } from 'node:url'
import './worker-dep.mjs'

if (isMainThread) {
  const worker = new Worker(new URL(import.meta.url))
  worker.on('error', (e) => {
    throw e
  })
} else {
  function dummyOperation (a) {
    return a + 'dummy operation with concat'
  }

  dummyOperation('should not crash')
}