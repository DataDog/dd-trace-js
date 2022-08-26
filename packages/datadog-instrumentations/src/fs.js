'use strict'

const { addHook, channel } = require('./helpers/instrument')

const hookChannel = channel('apm:fs:hook')

// HACK: trigger old style plugin
addHook({ name: 'fs' }, fs => {
  hookChannel.publish(fs)
  return fs
})
