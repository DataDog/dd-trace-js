const sanitizedExec = (cmd, options = {}) => {
  const { execSync } = require('child_process')
  try {
    return execSync(cmd, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

module.exports = { sanitizedExec }
