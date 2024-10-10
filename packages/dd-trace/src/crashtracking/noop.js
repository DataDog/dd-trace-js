'use strict'

class NoopCrashtracker {
  configure () {}
  start () {}
}

module.exports = new NoopCrashtracker()
