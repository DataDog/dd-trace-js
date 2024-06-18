const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const { isMainThread } = require('node:worker_threads')
const shimmer = require('../../datadog-shimmer')

// Needs modifying node_modules/.pnpm/import-in-the-middle@1.7.3/node_modules/import-in-the-middle/index.js
// the specifiers thing I don't understand

// needs creating a fake file node_modules/vitest/dist/@vitest/spy -- why????

const testStartCh = channel('ci:vitest:test:start')
const testFinishCh = channel('ci:vitest:test:finish')

const onAfterRunFilesCh = channel('ci:vitest:run-files')

const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')

const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')

const taskToAsync = new WeakMap()

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

// can I access VitestRunner???

const isVitestTestRunner = (vitestPackage) => {
  return vitestPackage.VitestTestRunner
}

const isReporter = (vitestPackage) => {
  // maybe we can use this as session start? maybe onCollected or similar
  return vitestPackage.D?.name === 'DefaultReporter'
}

const isVitestPlugin = (vitestPackage) => {
  return vitestPackage.B?.name === 'BaseSequencer' // maybe we can use #sort or something to start session
}

// --- do I need to specify a file? That's problematic because they contain a hash
addHook({
  name: 'vitest',
  versions: ['>=0.0.0']
}, (vitestPackage, frameworkVersion) => {
  // debugger
  if (isVitestPlugin(vitestPackage)) {
    // const oldVitestPlugin = vitestPackage.V
    // vitestPackage.V = async function () {
    //   debugger
    //   return oldVitestPlugin.apply(this, arguments)
    // }
    // const oldCreateVitest = vitestPackage.c
    // vitestPackage.c = async function () {
    //   debugger
    //   return oldCreateVitest.apply(this, arguments)
    // }

    // TODO: use shimmer
    const oldStartVitest = vitestPackage.s
    vitestPackage.s = async function () {
      // this has actually worked!!!
      debugger
      sessionAsyncResource.runInAsyncScope(() => {
        // TODO: change command to proper command
        testSessionStartCh.publish({ command: 'vitest run', frameworkVersion })
      })
      const res = await oldStartVitest.apply(this, arguments)

      sessionAsyncResource.runInAsyncScope(() => {
        // TODO: get proper status
        testSessionFinishCh.publish('pass')
      })
      debugger

      return res
    }
  }

  // maybe not needed
  // if (isReporter(vitestPackage)) {
  //   //  maybe not used
  //   shimmer.wrap(vitestPackage.D.prototype, 'onPathsCollected', onPathsCollected => async function (test) {
  //     debugger
  //     return onPathsCollected.apply(this, arguments)
  //   })
  // }

  if (isVitestTestRunner(vitestPackage)) {
    // test start
    shimmer.wrap(vitestPackage.VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      taskToAsync.set(task, asyncResource)

      asyncResource.runInAsyncScope(() => {
        testStartCh.publish({ testName: task.name, testSuiteAbsolutePath: task.suite.file.filepath })
      })
      return onBeforeTryTask.apply(this, arguments)
    })

    shimmer.wrap(vitestPackage.VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask => async function (task) {
      const res = await onAfterTryTask.apply(this, arguments)

      const asyncResource = taskToAsync.get(task)

      asyncResource.runInAsyncScope(() => {
        // TODO: if no error has been found, it's a pass.
        // See logic in packages/runner/src/run.ts in vitest after calling onAfterTryTask
        testFinishCh.publish('pass')
      })
      return res
    })

    // TODO: probably no need to flush so often - maybe we can use the test suite finish
    // shimmer.wrap(vitestPackage.VitestTestRunner.prototype, 'onAfterRunFiles', onAfterRunFiles => async function () {
    //   let onFinish = null
    //   const onFinishPromise = new Promise(resolve => {
    //     onFinish = resolve
    //   })

    //   onAfterRunFilesCh.publish(onFinish)

    //   await onFinishPromise

    //   return await onAfterRunFiles.apply(this, arguments)
    // })
  }
  return vitestPackage
})

addHook({
  name: '@vitest/runner',
  versions: ['>=0.0.0']
}, vitestPackage => {
  debugger
  if (vitestPackage.VitestRunner) {
    console.log('VitestRunner!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!')
  }
  // TODO: it does not seem to reach this point --- but it does using iitm directly --- why?
  // it reaches on workers only
  if (vitestPackage.startTests) {
    shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPath, vitestTestRunner) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      asyncResource.runInAsyncScope(() => {
        testSuiteStartCh.publish(testPath[0])
      })
      const startTestsResponse = await startTests.apply(this, arguments)

      let onFinish = null
      const onFinishPromise = new Promise(resolve => {
        onFinish = resolve
      })

      asyncResource.runInAsyncScope(() => {
        testSuiteFinishCh.publish({ status: startTestsResponse[0].result.state, onFinish })
      })

      console.log('waiting flush')
      await onFinishPromise
      console.log('flushed')

      return startTestsResponse
    })

    // const oldStartTests = vitestPackage.startTests
    // vitestPackage.startTests = async function (testPath, vitestTestRunner) {
    //   console.log('start suite', testPath[0])
    //   const res = await oldStartTests.apply(this, arguments)
    //   console.log('test suite finished', testPath[0])
    //   console.log('result', res[0].result.state)
    //   // console.log('tasks', res[0].tasks)
    //   return res
    // }
  }

  return vitestPackage
})

let privateSet

const isPrivateTools = (tinypoolPackage) => {
  return tinypoolPackage.__privateGet
}

const isTinyPoolClass = (tinypoolPackage) => {
  return tinypoolPackage.name === 'Tinypool'
}

const isThreadPool = (value) => {
  return value.constructor.name === 'ThreadPool'
}

let threadPool

// MAYBE NOT NEEDED IF I CAN PASS SESSION AND MODULE ID TO THE WORKERS
// addHook({
//   name: 'tinypool',
//   versions: ['>=0.0.0']
// }, tinypoolPackage => {
//   debugger
//   if (isPrivateTools(tinypoolPackage)) {
//     // maybe get private set??
//     const oldPrivateSet = tinypoolPackage.__privateSet

//     tinypoolPackage.__privateSet = function (obj, member, value, setter) {
//       if (isThreadPool(value)) {
//         threadPool = value
//         for (const worker of threadPool.workers.readyItems.values()) {
//           debugger
//           const oldWorkerMessage = worker.onMessage
//           worker.onMessage = function (message) {
//             debugger
//             // we have to stop our message from being handled
//             if (message.type === 'ci:vitest:worker:ready') {
//               return
//             }
//             return oldWorkerMessage.apply(this, arguments)
//           }
//           const oldMessageHandler = worker.worker.thread._events.message

//           worker.worker.thread.removeListener('message', oldMessageHandler)

//           worker.worker.thread.on('message', function (message) {
//             debugger
//             // we have to stop our message from being handled
//             if (message.type === 'ci:vitest:worker:ready') {
//               return
//             }
//             return oldMessageHandler.apply(this, arguments)
//           })

//           // debugger
//           // worker.worker.thread._events.message = function (message) {
//           //   debugger
//           //   // we have to stop our message from being handled
//           //   if (message.type === 'ci:vitest:worker:ready') {
//           //     return
//           //   }
//           //   return oldMessageHandler.apply(this, arguments)
//           // }
//         }
//       }
//       return oldPrivateSet.apply(this, arguments)
//     }
//   }
//   if (isTinyPoolClass(tinypoolPackage)) {
//     shimmer.wrap(tinypoolPackage.prototype, 'run', run => async function (task) {
//       debugger
//       const res = await run.apply(this, arguments)
//       debugger
//       return res
//     })
//   }
//   return tinypoolPackage
// })
