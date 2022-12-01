// TODO revert all changes in this file before merge it
'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const fsChannel = channel('datadog:fs:access')
const hookChannel = channel('apm:fs:hook')

const onePathMethods = ['access', 'appendFile', 'chmod', 'lchown', 'mkdir', 'mkdtemp', 'mkdtempSync', 'open',
  'openSync', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'truncate', 'unlink',
  'utimes', 'writeFile', 'watch']
const onePathPromiseMethods = ['access', 'open', 'opendir', 'truncate', 'rm', 'rmdir', 'mkdir', 'readdir', 'readlink',
  'stat', 'unlink', 'chmod', 'lchown', 'utimes', 'realpath', 'mkdtemp', 'writeFile', 'appendFile', 'readFile', 'watch']
const onePathMethodsSync = ['accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'lchownSync', 'mkdirSync',
  'opendirSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'rmSync', 'rmdirSync', 'statSync',
  'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync']
const twoPathMethods = ['copyFile', 'link', 'rename', 'symlink']
const twoPathMethodsSync = ['copyFileSync', 'linkSync', 'renameSync', 'symlinkSync']

addHook({ name: 'fs' }, fs => {
  const fsKeys = Object.keys(fs)
  shimmer.massWrap(fs, onePathMethods.concat(onePathMethodsSync).filter(key => fsKeys.includes(key)),
    wrapFsMethod(fsChannel, 1))
  shimmer.massWrap(fs, twoPathMethods.concat(twoPathMethodsSync).filter(key => fsKeys.includes(key)),
    wrapFsMethod(fsChannel, 2))

  const fsPromisesKeys = Object.keys(fs.promises)
  shimmer.massWrap(fs.promises, onePathPromiseMethods.filter(key => fsPromisesKeys.includes(key)),
    wrapFsMethod(fsChannel, 1))
  shimmer.massWrap(fs.promises, twoPathMethods.filter(key => fsPromisesKeys.includes(key)),
    wrapFsMethod(fsChannel, 2))
  if (hookChannel.hasSubscribers) {
    hookChannel.publish(fs)
  }
  return fs
})

function wrapFsMethod (channel, numParams) {
  function wrapMethod (fsMethod) {
    return function () {
      if (channel.hasSubscribers && arguments.length) {
        const args = Array.prototype.slice.call(arguments, 0, numParams)
        channel.publish({ arguments: args })
      }
      return fsMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}
