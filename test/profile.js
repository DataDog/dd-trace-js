'use strict'

const memwatch = require('@airbnb/node-memwatch')

function profile (t, operation, iterations, concurrency) {
  t.plan(1)

  iterations = iterations || 1000
  concurrency = concurrency || 5

  let error = null

  const handleWarning = e => {
    if (e.name === 'MaxListenersExceededWarning') {
      error = error || e
    }
  }

  process.on('warning', handleWarning)

  const promises = []
  const hd = new memwatch.HeapDiff()

  for (let i = 0; i < concurrency; i++) {
    const promise = new Promise((resolve, reject) => {
      start(0)

      function start (count) {
        if (count === iterations || error) {
          return resolve()
        }

        operation(() => {
          setImmediate(() => start(count + 1))
        })
      }
    })

    promises.push(promise)
  }

  return Promise.all(promises)
    .then(() => {
      if (error) {
        log(t, error.stack)
        t.fail('event listener leak detected')
        return
      }

      const diff = hd.end()
      const leaks = diff.change.details.filter(change => {
        const max = iterations * concurrency

        return change['+'] >= max
      })

      process.removeListener('warning', handleWarning)

      if (leaks.length > 0) {
        log(t, JSON.stringify(diff, null, 2))
        t.fail('memory leak detected')
      } else {
        t.pass('no memory leak detected')
      }
    })
}

function log (t, message) {
  message.split('\n').forEach(line => {
    t.emit('result', line)
  })
}

module.exports = profile
