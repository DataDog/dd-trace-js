'use strict'

const shimmer = require('../../../datadog-shimmer')
const {
  getTestSuitePath,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  JEST_WORKER_TELEMETRY_PAYLOAD_CODE,
} = require('../../../dd-trace/src/plugins/util/test')
const { addHook } = require('../helpers/instrument')
const {
  workerReportTraceCh,
  workerReportCoverageCh,
  workerReportLogsCh,
  workerReportTelemetryCh,
  CHILD_MESSAGE_CALL,
} = require('./channels')
const {
  state,
  wrappedWorkers,
  newTestsWithDynamicNames,
} = require('./state')

function collectDynamicNamesFromTraces (data) {
  try {
    const traces = JSON.parse(data)
    for (const trace of traces) {
      for (const span of trace) {
        if (span.meta?.['_dd.has_dynamic_name'] === 'true') {
          const suite = span.meta['test.suite']
          const name = span.meta['test.name']
          if (suite && name) {
            newTestsWithDynamicNames.add(`${suite} › ${name}`)
          }
        }
      }
    }
  } catch {
    // ignore parse errors — trace will still be forwarded
  }
}

function onMessageWrapper (onMessage) {
  return function () {
    const [code, data] = arguments[0]
    if (code === JEST_WORKER_TRACE_PAYLOAD_CODE) { // datadog trace payload
      collectDynamicNamesFromTraces(data)
      workerReportTraceCh.publish(data)
      return
    }
    if (code === JEST_WORKER_COVERAGE_PAYLOAD_CODE) { // datadog coverage payload
      workerReportCoverageCh.publish(data)
      return
    }
    if (code === JEST_WORKER_LOGS_PAYLOAD_CODE) { // datadog logs payload
      workerReportLogsCh.publish(data)
      return
    }
    if (code === JEST_WORKER_TELEMETRY_PAYLOAD_CODE) { // datadog telemetry payload
      workerReportTelemetryCh.publish(data)
      return
    }
    return onMessage.apply(this, arguments)
  }
}

function sendWrapper (send) {
  return function (request) {
    if (!state.isKnownTestsEnabled && !state.isTestManagementTestsEnabled && !state.isImpactedTestsEnabled) {
      return send.apply(this, arguments)
    }
    const [type] = request

    // https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/workers/ChildProcessWorker.ts#L424
    if (type === CHILD_MESSAGE_CALL) {
      // This is the message that the main process sends to the worker to run a test suite (=test file).
      // In here we modify the `config.testEnvironmentOptions` to include the known tests for the suite.
      // This way the suite only knows about the tests that are part of it.
      const args = request.at(-1)
      if (args.length > 1) {
        return send.apply(this, arguments)
      }
      if (!args[0]?.config) {
        return send.apply(this, arguments)
      }
      const [{ globalConfig, config, path: testSuiteAbsolutePath }] = args
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, globalConfig.rootDir || process.cwd())
      const suiteKnownTests = state.knownTests?.jest?.[testSuite] || []

      const suiteTestManagementTests = state.testManagementTests?.jest?.suites?.[testSuite]?.tests || {}

      args[0].config = {
        ...config,
        testEnvironmentOptions: {
          ...config.testEnvironmentOptions,
          _ddKnownTests: suiteKnownTests,
          _ddTestManagementTests: suiteTestManagementTests,
          // TODO: figure out if we can reduce the size of the modified files object
          // Can we use `testSuite` (it'd have to be relative to repository root though)
          _ddModifiedFiles: state.modifiedFiles,
        },
      }
    }
    return send.apply(this, arguments)
  }
}

function wrapWorker (worker) {
  // ChildProcessWorker uses _child (child_process), ExperimentalWorker uses _worker (worker_threads)
  const workerChannel = worker._child || worker._worker
  if (!workerChannel) return

  shimmer.wrap(workerChannel, worker._child ? 'send' : 'postMessage', sendWrapper)
  shimmer.wrap(worker, '_onMessage', onMessageWrapper)
  workerChannel.removeAllListeners('message')
  workerChannel.on('message', worker._onMessage.bind(worker))
}

function enqueueWrapper (enqueue) {
  return function () {
    shimmer.wrap(arguments[0], 'onStart', onStart => function (worker) {
      if (worker && !wrappedWorkers.has(worker)) {
        wrapWorker(worker)
        wrappedWorkers.add(worker)
      }
      return onStart.apply(this, arguments)
    })
    return enqueue.apply(this, arguments)
  }
}

/*
* This hook does three things:
* - Pass known tests to the workers.
* - Pass test management tests to the workers.
* - Receive trace, coverage and logs payloads from the workers.
*/
addHook({
  name: 'jest-worker',
  versions: ['>=24.9.0 <30.0.0'],
  file: 'build/workers/ChildProcessWorker.js',
}, (childProcessWorker) => {
  const ChildProcessWorker = childProcessWorker.default
  shimmer.wrap(ChildProcessWorker.prototype, 'send', sendWrapper)
  if (ChildProcessWorker.prototype._onMessage) {
    shimmer.wrap(ChildProcessWorker.prototype, '_onMessage', onMessageWrapper)
  } else if (ChildProcessWorker.prototype.onMessage) {
    shimmer.wrap(ChildProcessWorker.prototype, 'onMessage', onMessageWrapper)
  }
  return childProcessWorker
})

addHook({
  name: 'jest-worker',
  versions: ['>=24.9.0 <30.0.0'],
  file: 'build/workers/NodeThreadsWorker.js',
}, (nodeThreadsWorker) => {
  const ExperimentalWorker = nodeThreadsWorker.default
  shimmer.wrap(ExperimentalWorker.prototype, 'send', sendWrapper)
  if (ExperimentalWorker.prototype._onMessage) {
    shimmer.wrap(ExperimentalWorker.prototype, '_onMessage', onMessageWrapper)
  } else if (ExperimentalWorker.prototype.onMessage) {
    shimmer.wrap(ExperimentalWorker.prototype, 'onMessage', onMessageWrapper)
  }
  return nodeThreadsWorker
})

addHook({
  name: 'jest-worker',
  versions: ['>=30.0.0'],
}, (jestWorkerPackage) => {
  shimmer.wrap(jestWorkerPackage.FifoQueue.prototype, 'enqueue', enqueueWrapper)
  shimmer.wrap(jestWorkerPackage.PriorityQueue.prototype, 'enqueue', enqueueWrapper)
  return jestWorkerPackage
})
