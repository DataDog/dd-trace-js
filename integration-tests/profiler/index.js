'use strict'

require('dd-trace').init()

function busyWait (ms) {
  return new Promise(resolve => {
    let done = false
    function work () {
      if (done) return
      let sum = 0
      for (let i = 0; i < 1e6; i++) {
        sum += sum
      }
      setImmediate(work, sum)
    }
    setImmediate(work)
    setTimeout(() => {
      done = true
      resolve(undefined)
    }, ms)
  })
}

// Runner expects child process to end a port
process.send({ port: 0 })

setImmediate(async () => busyWait(500))
