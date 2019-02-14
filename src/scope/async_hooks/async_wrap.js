'use strict'

let asyncHook

try {
  // load async-hook if the user is using it
  asyncHook = require('async-hook')
} catch (e) {
  // otherwise load the more recent async-hook-jl
  asyncHook = require('async-hook-jl')
}

const stack = []

module.exports = {
  createHook (callbacks) {
    const hooks = {}

    if (callbacks.init) {
      hooks.init = (uid, handle, provider, parentUid, parentHandle) => {
        callbacks.init(uid)
      }
    }

    if (callbacks.before) {
      hooks.pre = (uid, handle) => {
        callbacks.before(uid)
      }
    }

    if (callbacks.after) {
      hooks.post = (uid, handle, didThrow) => {
        callbacks.after(uid)
      }
    }

    if (callbacks.destroy) {
      hooks.destroy = (uid) => {
        callbacks.destroy(uid)
      }
    }

    asyncHook.addHooks({
      pre: (uid, handle) => {
        stack.push(uid)
      },
      post: (uid, handle, didThrow) => {
        if (uid === this.executionAsyncId()) {
          stack.pop()
        }
      }
    })

    asyncHook.enable()

    return {
      enable: () => asyncHook.addHooks(hooks),
      disable: () => asyncHook.removeHooks(hooks)
    }
  },

  executionAsyncId () {
    return stack[stack.length - 1] || 0
  }
}
