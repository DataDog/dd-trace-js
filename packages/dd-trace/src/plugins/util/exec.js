const { execSync } = require('child_process')

const sanitizedExec = (cmd, options = {}) => {
  try {
    return execSync(cmd, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

module.exports = { sanitizedExec }
