const cp = require('child_process')
const log = require('../../log')
const { storage } = require('../../../../datadog-core')

const sanitizedExec = (cmd, flags, options = { stdio: 'pipe' }) => {
  const store = storage.getStore()
  storage.enterWith({ noop: true })
  try {
    return cp.execFileSync(cmd, flags, options).toString().replace(/(\r\n|\n|\r)/gm, '')
  } catch (e) {
    log.error(e)
    return ''
  } finally {
    storage.enterWith(store)
  }
}

module.exports = { sanitizedExec }
