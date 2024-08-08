'use strict'

const log = require('../../dd-trace/src/log')

// Use a weak map to avoid polluting the wrapped function/method.
const unwrappers = new WeakMap()

function copyProperties (original, wrapped) {
  Object.setPrototypeOf(wrapped, original)

  const props = Object.getOwnPropertyDescriptors(original)
  const keys = Reflect.ownKeys(props)

  for (const key of keys) {
    try {
      Object.defineProperty(wrapped, key, props[key])
    } catch (e) {
      // TODO: figure out how to handle this without a try/catch
    }
  }
}

const wrapFn = function (original, delegate) {
  assertFunction(delegate)
  assertNotClass(original) // TODO: support constructors of native classes

  const shim = function shim () {
    return delegate.apply(this, arguments)
  }

  unwrappers.set(shim, () => {
    delegate = original
  })

  copyProperties(original, shim)

  return shim
}

const CALLED = Symbol('__dd_called')
const RETVAL = Symbol('__dd_retVal')
const IS_PROMISE = Symbol('__dd_isPromise')

function wasCalled (fn) {
  return fn[CALLED]
}

function wasReturned (fn) {
  return Reflect.has(fn, RETVAL) && fn[RETVAL] !== IS_PROMISE
}

function isPromise (obj) {
  return obj && typeof obj === 'object' && typeof obj.then === 'function'
}

let safeWrap = !!process.env.DD_INEJCTION_ENABLED
function setSafe (value) {
  safeWrap = value
}

function wrapMethod (target, name, wrapper) {
  assertMethod(target, name)
  assertFunction(wrapper)

  const origOriginal = target[name]
  let original = origOriginal
  let wrapped = wrapper(original)
  if (safeWrap) {
    // Wrap the original method to track if it was called and if it returned.
    // We'll need that to determine if an error was thrown by the original method, or by us.
    // Caveats:
    //   * If the original method is called recursively, this tracking doesn't work.
    //     A less naive implementation would use a stack, or even just use
    //     AsyncLocalStorage.
    //   * If the original method is called in a later iteration of the event loop,
    //     and we throw _then_, then it won't be caught by this.
    //   * While async errors are dealt with here, errors in callbacks are not. This
    //     is because we don't necessarily know _for sure_ that any function arguments
    //     are wrapped by us. We could wrap them all anyway and just make that assumption,
    //     or just assume that the last argument is always a callback set by us if it's a
    //     function, but those don't seem like things we can rely on. We could add a
    //     `shimmer.markCallbackAsWrapped()` function that's a no-op outside safe-mode,
    //     but that means modifying every instrumentation. Even then, the complexity of
    //     this code increases because then we'd need to effectively do the reverse of
    //     what we're doing for synchronous functions.

    let holderForWrapped
    const wrapWrapped = wrapper(function (...args) {
      const holder = holderForWrapped
      holder[CALLED] = true
      const retVal = origOriginal.apply(this, args)
      if (isPromise(retVal)) {
        retVal.then(val => {
          holder[RETVAL] = val
        })
        holder[RETVAL] = IS_PROMISE
      } else {
        holder[RETVAL] = retVal
      }
      return retVal
    })

    wrapped = function (...args) {
      // TODO this should be wrapped _once_, not on every invocation!
      // It's here inside this closure so that it has access to holder, which
      // needs to exist per-invocation. Instead, some invocation-specific variable
      // should be passed around, perhaps via some WeakMap or something.
      let holder = {}
      holderForWrapped = holder

      const handleError = function (e, args) {
        if (wasCalled(holder) && !wasReturned(holder)) {
          // it was them. throw.
          throw e
        } else {
          // it was us. swallow/log it.
          log.error(e)
          if (!wasCalled(holder)) {
            // original never ran. call it unwrapped.
            return origOriginal.apply(this, args)
          } else if (wasReturned(holder)) {
            // original ran and returned something. return it.
            return holder[RETVAL]
          }
        }
      }

      try {
        const retVal = wrapWrapped.apply(this, args)
        if (isPromise(retVal)) {
          // It's a promise. We need to wrap it to catch any errors that happen in the promise.
          return retVal.catch((e) => {
            return handleError.call(this, e, args)
          })
        } else {
          return retVal
        }
      } catch (e) {
        return handleError.call(this, e, args)
      } finally {
        delete holder[CALLED]
        if (holder[RETVAL] !== IS_PROMISE) {
          delete holder[RETVAL]
        }
      }
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(target, name)

  const attributes = {
    configurable: true,
    ...descriptor
  }

  copyProperties(original, wrapped)

  if (descriptor) {
    unwrappers.set(wrapped, () => Object.defineProperty(target, name, descriptor))

    if (descriptor.get || descriptor.set) {
      attributes.get = () => wrapped
    } else {
      attributes.value = wrapped
    }

    // TODO: create a single object for multiple wrapped methods
    if (descriptor.configurable === false) {
      return Object.create(target, {
        [name]: attributes
      })
    }
  } else { // no descriptor means original was on the prototype
    unwrappers.set(wrapped, () => delete target[name])
    attributes.value = wrapped
    attributes.writable = true
  }

  Object.defineProperty(target, name, attributes)

  return target
}

function wrap (target, name, wrapper) {
  return typeof name === 'function'
    ? wrapFn(target, name)
    : wrapMethod(target, name, wrapper)
}

function unwrap (target, name) {
  if (!target) return target // no target to unwrap

  const unwrapper = unwrappers.get(name ? target[name] : target)

  if (!unwrapper) return target // target is already unwrapped or isn't wrapped

  unwrapper()

  return target
}

function massWrap (targets, names, wrapper) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      wrap(target, name, wrapper)
    }
  }
}

function massUnwrap (targets, names) {
  targets = toArray(targets)
  names = toArray(names)

  for (const target of targets) {
    for (const name of names) {
      unwrap(target, name)
    }
  }
}

function toArray (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}

function assertMethod (target, name) {
  if (!target) {
    throw new Error('No target object provided.')
  }

  if (typeof target !== 'object' && typeof target !== 'function') {
    throw new Error('Invalid target.')
  }

  if (!target[name]) {
    throw new Error(`No original method ${name}.`)
  }

  if (typeof target[name] !== 'function') {
    throw new Error(`Original method ${name} is not a function.`)
  }
}

function assertFunction (target) {
  if (!target) {
    throw new Error('No function provided.')
  }

  if (typeof target !== 'function') {
    throw new Error('Target is not a function.')
  }
}

function assertNotClass (target) {
  if (Function.prototype.toString.call(target).startsWith('class')) {
    throw new Error('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  massWrap,
  unwrap,
  massUnwrap,
  setSafe
}
