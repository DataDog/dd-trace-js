const { enableRewriter, disableRewriter } = require('./rewriter')
const { createTransaction, removeTransaction, enableTaintOperations, disableTaintOperations } = require('./operations')

module.exports = {
  enableTaintTracking () {
    enableRewriter()
    enableTaintOperations()
  },
  disableTaintTracking () {
    disableRewriter()
    disableTaintOperations()
  },
  createTransaction: createTransaction,
  removeTransaction: removeTransaction
}
