const { readFileSync } = require('fs')

function readFile (filename) {
  try {
    return readFileSync(__dirname + '/' + filename).toString()
  } catch (e) {
    // do nothing
  }
}

module.exports = {
  readFile
}
