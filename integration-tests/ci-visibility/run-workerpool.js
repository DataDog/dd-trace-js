'use strict'

const workerpool = require('workerpool')
const pool = workerpool.pool({ workerType: 'process' })

function add (a, b) {
  return a + b
}

pool
  .exec(add, [3, 4])
  .then((result) => {
    // eslint-disable-next-line no-console
    console.log('result', result) // outputs 7
    return pool.terminate()
  })
  .catch(function (err) {
    // eslint-disable-next-line no-console
    console.error(err)
    process.exit(1)
  })
  .then(() => {
    process.exit(0)
  })
