'use strict'

const skipMethods = new Set([
  'caller',
  'arguments',
  'name',
  'length'
])

const nonConfigurableModuleExports = new WeakMap()

function copyProperties (original, wrapped) {
  if (original.constructor !== wrapped.constructor) {
    const proto = Object.getPrototypeOf(original)
    Object.setPrototypeOf(wrapped, proto)
  }

  const ownKeys = Reflect.ownKeys(original)
  if (original.length !== wrapped.length) {
    Object.defineProperty(wrapped, 'length', { value: original.length, configurable: true })
  }
  if (original.name !== wrapped.name) {
    Object.defineProperty(wrapped, 'name', { value: original.name, configurable: true })
  }
  if (ownKeys.length !== 2) {
    for (const key of ownKeys) {
      if (skipMethods.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(original, key)
      if (descriptor.writable && descriptor.enumerable && descriptor.configurable) {
        wrapped[key] = original[key]
      } else if (descriptor.writable || descriptor.configurable || !Object.hasOwn(wrapped, key)) {
        Object.defineProperty(wrapped, key, descriptor)
      }
    }
  }
}

function copyObjectProperties (original, wrapped, skipKey) {
  const ownKeys = Reflect.ownKeys(original)
  for (const key of ownKeys) {
    if (key === skipKey) continue
    const descriptor = Object.getOwnPropertyDescriptor(original, key)
    if (descriptor.writable && descriptor.enumerable && descriptor.configurable) {
      wrapped[key] = original[key]
    } else if (descriptor.writable || descriptor.configurable || !Object.hasOwn(wrapped, key)) {
      Object.defineProperty(wrapped, key, descriptor)
    }
  }
}

function wrapFunction (original, wrapper) {
  const wrapped = wrapper(original)

  if (typeof original === 'function') {
    assertNotClass(original)
    copyProperties(original, wrapped)
  }

  return wrapped
}

function wrap (target, name, wrapper, options) {
  if (typeof wrapper !== 'function') {
    throw new Error(wrapper ? 'Target is not a function' : 'No function provided')
  }

  let descriptor = Object.getOwnPropertyDescriptor(target, name)
  const original = descriptor?.get && (!options?.replaceGetter || descriptor.set) ? descriptor.get : target[name]

  assertMethod(target, name, original)

  const wrapped = wrapper(original)

  copyProperties(original, wrapped)

  // No descriptor means original was on the prototype
  if (descriptor === undefined) {
    descriptor = {
      value: wrapped,
      writable: true,
      configurable: true,
      enumerable: false
    }
  } else if (descriptor.writable) {
    // Fast path for assigned properties.
    if (descriptor.configurable && descriptor.enumerable) {
      target[name] = wrapped
      return target
    }
    descriptor.value = wrapped
  } else {
    if (descriptor.get) {
      // replaceGetter may only be used when the getter has no side effect.
      if (options?.replaceGetter) {
        if (descriptor.set) {
          // This case is possible by replacing the setter with a wrapper that
          // either undos the original get replacement (that should be safe to
          // do, we just loose the instrumentation afterwards) or that
          // reinstruments the passed through value after calling get. The
          // latter might however have side effects due to maybe not replacing
          // the value that the getter instrumented.
          throw new Error('Replacing getter with sets is not supported. Implement if required.')
        }
        descriptor.get = () => wrapped
      } else {
        descriptor.get = wrapped
      }
    } else if (descriptor.set) {
      throw new Error('Replacing setters is not supported. Implement if required.')
    } else {
      descriptor.value = wrapped
    }

    if (descriptor.configurable === false) {
      // TODO(BridgeAR): This currently only works on the most outer part. The
      // moduleExports object.
      //
      // It would be possible to also implement it for non moduleExports objects
      // by passing through the moduleExports object and the property names that
      // are accessed. That way it would be possible to redefine the complete
      // property chain. Example:
      //
      // shimmer.wrap(hapi.Server.prototype, 'start', wrapStart)
      // shimmer.wrap(hapi.Server.prototype, 'ext', wrapExt)
      //
      // shimmer.wrap(hapi, 'Server', 'prototype', 'start', wrapStart)
      // shimmer.wrap(hapi, 'Server', 'prototype', 'ext', wrapExt)
      //
      // That would however still not resolve the issue about the user replacing
      // the return value so that the hook picks up the new hapi moduleExports
      // object. To safely fix that, we would have to couple the register helper
      // with this code. That way it would be possible to directly pass through
      // the entries.

      // In case more than a single property is not configurable and writable,
      // Just reuse the already created object.
      let moduleExports = nonConfigurableModuleExports.get(target)
      if (!moduleExports) {
        if (typeof target === 'function') {
          const original = target
          moduleExports = function (...args) { return original.apply(original, args) }
          // This is a rare case. Accept the slight performance hit.
          skipMethods.add(name)
          copyProperties(target, moduleExports)
          skipMethods.delete(name)
        } else {
          moduleExports = Object.create(target)
          copyObjectProperties(target, moduleExports, name)
        }
        nonConfigurableModuleExports.set(target, moduleExports)
      }
      target = moduleExports
    }
  }

  Object.defineProperty(target, name, descriptor)

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

function toArray (maybeArray) {
  return Array.isArray(maybeArray) ? maybeArray : [maybeArray]
}

function assertMethod (target, name, method) {
  if (typeof method !== 'function') {
    let message = 'No target object provided'

    if (target) {
      if (typeof target !== 'object' && typeof target !== 'function') {
        message = 'Invalid target'
      } else {
        message = method ? `Original method ${name} is not a function` : `No original method ${name}`
      }
    }

    throw new Error(message)
  }
}

function assertNotClass (target) {
  if (Function.prototype.toString.call(target).startsWith('class')) {
    throw new Error('Target is a native class constructor and cannot be wrapped.')
  }
}

module.exports = {
  wrap,
  wrapFunction,
  massWrap
}
