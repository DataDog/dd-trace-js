const cp = require('child_process')

const sanitizedExec = (cmd, options = {}) => {
  try {
    return cp.execSync(cmd, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

module.exports = { sanitizedExec }
