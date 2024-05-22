'use strict'

const DDTrace = require('dd-trace')

const tracer = DDTrace.init()

async function run () {
  const tasks = []
  // If launched with 'create-span', the app will create a span.
  if (process.argv.includes('create-span')) {
    tasks.push(tracer.trace('woo', _ => {
      return new Promise(setImmediate)
    }))
  }
  // If launched with 'long-lived', the app will remain alive long enough to
  // be considered long-lived by profiler activation heuristics.
  if (process.argv.includes('long-lived')) {
    const longLivedThreshold = Number(process.env.DD_INTERNAL_PROFILING_LONG_LIVED_THRESHOLD)
    tasks.push(new Promise(resolve => setTimeout(resolve, longLivedThreshold + 200)))
  }
  await Promise.all(tasks)
}

tracer.profilerStarted().then(run)
