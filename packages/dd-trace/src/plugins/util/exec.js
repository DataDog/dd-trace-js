const cp = require('child_process')

const sanitizedExec = (cmd, flags, options = { stdio: 'pipe' }) => {
  try {
    return cp.execFileSync(cmd, flags, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    return ''
  }
}

module.exports = { sanitizedExec }
