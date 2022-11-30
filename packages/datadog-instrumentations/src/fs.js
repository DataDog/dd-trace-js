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
const onePathMethodsSync = ['accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'lchownSync', 'mkdirSync',
  'opendirSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'rmSync', 'rmdirSync', 'statSync',
  'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync']
const twoPathMethods = ['copyFile', 'link', 'rename', 'symlink']
const twoPathMethodsSync = ['copyFileSync', 'linkSync', 'renameSync', 'symlinkSync']

addHook({ name: 'fs' }, fs => {
  const allOnePathMethods = onePathMethods.concat(onePathMethodsSync)
  const allTwoPathMethods = twoPathMethods.concat(twoPathMethodsSync)
  const allFsProperties = Object.keys(fs)
  const allFsPromisesProperties = Object.keys(fs.promises)
  shimmer.massWrap(fs, allFsProperties.filter(name => allOnePathMethods.includes(name)), wrapFsMethod(fsChannel, 1))
  shimmer.massWrap(fs, allFsProperties.filter(name => allTwoPathMethods.includes(name)), wrapFsMethod(fsChannel, 2))

  shimmer.massWrap(fs.promises, allFsPromisesProperties.filter(name => onePathMethods.includes(name)),
    wrapFsMethod(fsChannel, 1))
  shimmer.massWrap(fs.promises, allFsPromisesProperties.filter(name => twoPathMethods.includes(name)),
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
