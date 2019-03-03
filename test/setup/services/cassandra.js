'use strict'

const RetryOperation = require('../operation')
const cassandra = require('../../../versions/cassandra-driver').get()

function waitForCassandra () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('cassandra')

    operation.attempt(currentAttempt => {
      const client = new cassandra.Client({
        contactPoints: ['127.0.0.1'],
        localDataCenter: 'datacenter1'
      })

      client.connect(err => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        const createKeyspace = `
          CREATE KEYSPACE IF NOT EXISTS test WITH REPLICATION = {
            'class' : 'SimpleStrategy',
            'replication_factor' : 1
          };
        `

        const createTable = `
          CREATE TABLE IF NOT EXISTS test.test (
            id text PRIMARY KEY,
            test text
          );
        `

        client.execute(createKeyspace, err => {
          if (err) return reject(err)

          client.execute(createTable, err => {
            if (err) return reject(err)

            client.shutdown(err => err ? reject(err) : resolve())
          })
        })
      })
    })
  })
}

module.exports = waitForCassandra
