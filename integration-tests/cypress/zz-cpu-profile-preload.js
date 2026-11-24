'use strict'

// Temporary experiment: writes this process' V8 CPU profile on exit. Node 18 rejects --cpu-prof in NODE_OPTIONS, so
// the profiler is started through the inspector instead. Not meant to be merged.

const fs = require('node:fs')
const inspector = require('node:inspector')
const path = require('node:path')

const outputDir = process.env.CYPRESS_PROFILE_OUTPUT

if (outputDir) {
  const session = new inspector.Session()
  session.connect()
  session.post('Profiler.enable')
  session.post('Profiler.setSamplingInterval', { interval: 1000 })
  session.post('Profiler.start')

  let written = false
  const write = () => {
    if (written) return
    written = true
    // The in-process session answers synchronously, so this completes before the process exits.
    session.post('Profiler.stop', (error, result) => {
      if (error) return
      fs.writeFileSync(path.join(outputDir, `CPU.${process.pid}.cpuprofile`), JSON.stringify(result.profile))
    })
  }

  process.on('exit', write)
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      write()
      process.kill(process.pid, signal)
    })
  }
}
