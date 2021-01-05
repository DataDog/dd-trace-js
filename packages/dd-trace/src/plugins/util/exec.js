const { execSync } = require('child_process')

const sanitizedExec = cmd => {
  try {
    return execSync(cmd).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

module.exports = { sanitizedExec }
