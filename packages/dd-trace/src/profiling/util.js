'use strict'

function maybeRequire (id) {
  try {
    return require(id)
  } catch (e) {
    return null
  }
}

function eachSeries (collection, iteratee, callback) {
  eachOfSeries(collection, (item, index, callback) => iteratee(item, callback), callback)
}

function eachOfSeries (collection, iteratee, callback = () => {}) {
  const results = []
  const next = index => {
    if (collection[index]) {
      iteratee(collection[index], index, (err, result) => {
        if (err) return callback(err)

        results.push(result)

        next(index + 1)
      })
    } else {
      callback(null, results)
    }
  }

  next(0)
}

function parallel (tasks, callback) {
  const results = new Array(tasks.length)

  let counter = 0
  let error = null

  for (let i = 0; i < tasks.length; i++) {
    const taskIndex = i

    tasks[taskIndex]((err, result) => {
      if (err && !error) {
        error = err
      }

      results[taskIndex] = result

      if (++counter === tasks.length) {
        error ? callback(error) : callback(null, results)
      }
    })
  }
}

module.exports = {
  maybeRequire,
  parallel,
  eachSeries,
  eachOfSeries
}
