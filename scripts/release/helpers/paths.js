'use strict'

const os = require('os')
const path = require('path')

function darwin (name) {
  return path.join(process.env.HOME, 'Library', 'Application Support', name)
}

function xdg (name) {
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, name)
  }

  return path.join(process.env.HOME, '.config', name)
}

function win32 (name) {
  if (process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, name)
  }

  return path.join(process.env.USERPROFILE, 'Local Settings', 'Application Data', name)
}

function applicationConfigPath (name) {
  if (typeof name !== 'string') {
    throw new TypeError('`name` must be string')
  }

  switch (os.platform()) {
    case 'darwin': return darwin(name)
    case 'freebsd':
    case 'openbsd':
    case 'linux': return xdg(name)
    case 'win32': return win32(name)
  }

  throw new Error('Platform not supported')
}

module.exports = { applicationConfigPath }
