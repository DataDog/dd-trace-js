const { enableRewriter, disableRewriter } = require('./rewriter')
const { taintOperations } = require('./operations')

module.exports = {
  enableTaintTracking () {
    enableRewriter()
    taintOperations.enable()
  },
  disableTaintTracking () {
    disableRewriter()
    taintOperations.disable()
  },
  createTransaction: taintOperations.createTransaction,
  removeTransaction: taintOperations.removeTransaction
}
