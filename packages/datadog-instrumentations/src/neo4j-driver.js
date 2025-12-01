// THIS FILE WILL DISSAPPEAR ONCE ORCHESTRION-JS WORKS !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

'use strict'

const { addHook } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const { createWrapper } = require('./helpers/wrappers')

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const SessionClass = exports.Session
  if (SessionClass && SessionClass.prototype && SessionClass.prototype.run) {
    shimmer.wrap(SessionClass.prototype, 'run', createWrapper('apm:neo4j-driver:session:run', 'tracePromise'))
  }
  return exports
})

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const TransactionClass = exports.Transaction
  if (TransactionClass && TransactionClass.prototype && TransactionClass.prototype.run) {
    shimmer.wrap(TransactionClass.prototype, 'run', createWrapper('apm:neo4j-driver:transaction:run', 'tracePromise'))
  }
  return exports
})

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const SessionClass = exports.Session
  if (SessionClass && SessionClass.prototype && SessionClass.prototype.executeRead) {
    shimmer.wrap(SessionClass.prototype, 'executeRead', createWrapper('apm:neo4j-driver:session:executeread', 'tracePromise'))
  }
  return exports
})

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const SessionClass = exports.Session
  if (SessionClass && SessionClass.prototype && SessionClass.prototype.executeWrite) {
    shimmer.wrap(SessionClass.prototype, 'executeWrite', createWrapper('apm:neo4j-driver:session:executewrite', 'tracePromise'))
  }
  return exports
})

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const TransactionClass = exports.Transaction
  if (TransactionClass && TransactionClass.prototype && TransactionClass.prototype.commit) {
    shimmer.wrap(TransactionClass.prototype, 'commit', createWrapper('apm:neo4j-driver:transaction:commit', 'tracePromise'))
  }
  return exports
})

addHook({ name: 'neo4j-driver', versions: ['^6.0.1'] }, (exports) => {
  const TransactionClass = exports.Transaction
  if (TransactionClass && TransactionClass.prototype && TransactionClass.prototype.rollback) {
    shimmer.wrap(TransactionClass.prototype, 'rollback', createWrapper('apm:neo4j-driver:transaction:rollback', 'tracePromise'))
  }
  return exports
})
