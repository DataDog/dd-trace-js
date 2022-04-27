require('../../../ci/jest/env')

const node = require(`../../../versions/jest-environment-node@${global.__libraryVersion__}`).get()

module.exports = node.default ? node.default : node
