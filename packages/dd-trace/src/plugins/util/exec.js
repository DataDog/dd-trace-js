const cp = require('child_process')
const log = require('../../log')

const sanitizedExec = (cmd, flags, options = { stdio: 'pipe' }) => {
  try {
    return cp.execFileSync(cmd, flags, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    log.error(e)
    return ''
  }
}

module.exports = { sanitizedExec }
