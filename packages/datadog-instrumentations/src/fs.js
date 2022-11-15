'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const fsCahnnel = channel('datadog:fs:access')
const onePathMethods = ['access', 'appendFile', 'chmod', 'lchown', 'mkdir', 'mkdtemp', 'mkdtempSync', 'open',
  'openSync', 'opendir', 'readdir', 'readFile', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'truncate', 'unlink',
  'utimes', 'writeFile', 'watch']
const onePathMethodsSync = ['accessSync', 'appendFileSync', 'chmodSync', 'chownSync', 'lchownSync', 'mkdirSync',
  'opendirSync', 'readdirSync', 'readFileSync', 'readlinkSync', 'realpathSync', 'rmSync', 'rmdirSync', 'statSync',
  'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync']
const twoPathMethods = ['copyFile', 'link', 'rename', 'symlink']
const twoPathMethodsSync = ['copyFileSync', 'linkSync', 'renameSync', 'symlinkSync']

addHook({ name: 'fs' }, fs => {
  shimmer.massWrap(fs, onePathMethods.concat(onePathMethodsSync), wrapFsMethod(fsCahnnel, 1))
  shimmer.massWrap(fs, twoPathMethods.concat(twoPathMethodsSync), wrapFsMethod(fsCahnnel, 2))

  shimmer.massWrap(fs.promises, onePathMethods, wrapFsMethod(fsCahnnel, 1))
  shimmer.massWrap(fs.promises, twoPathMethods, wrapFsMethod(fsCahnnel, 2))
  return fs
})

function wrapFsMethod (channel, numParams) {
  function wrapMethod (fsMethod) {
    return function () {
      if (channel.hasSubscribers && arguments.length) {
        const args = []
        for (let i = 0; i < numParams; i++) {
          args.push(arguments[i])
        }
        channel.publish(args)
      }
      return fsMethod.apply(this, arguments)
    }
  }
  return wrapMethod
}
