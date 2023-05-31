const env = require(`../../../versions/${global.__libraryName__}@${global.__libraryVersion__}`).get()

module.exports = env.default ? env.default : env
