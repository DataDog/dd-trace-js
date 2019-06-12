'use strict'

const RetryOperation = require('../operation')
const mongo = require('../../../versions/mongodb-core').get()

function waitForMongo () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('mongo')

    operation.attempt(currentAttempt => {
      // const server = new mongo.ReplSet([{
      //   host: 'localhost',
      //   port: 27017
      // }], {
      //   setName: 'replicaset',
      //   reconnect: false
      // })

      const server = new mongo.Server({
        host: 'localhost',
        port: 27017,
        reconnect: false
      })

      server.on('connect', server => {
        server.destroy()
        resolve()
      })

      server.on('error', err => {
        if (!operation.retry(err)) {
          reject(err)
        }
      })

      server.connect()
    })
  })
}

module.exports = waitForMongo
