import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { URL } from 'node:url'
import './worker-dep.mjs'

if (isMainThread) {
  new Worker(new URL(import.meta.url));
} else {
  function dummyOperation (a) {
    return a + 'dummy operation with concat'
  }

  dummyOperation('should not crash')
}
