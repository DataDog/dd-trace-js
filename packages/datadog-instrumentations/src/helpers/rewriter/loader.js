'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { getRewriteTarget } = require('./targets')
const { rewrite } = require('./')

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  return compile.call(this, rewrite(content, filename, format), filename, format)
})

if (process.versions.bun) {
  // Bun compiles CommonJS natively without calling `Module.prototype._compile`, and only consults
  // `Module._extensions` for `.cjs` files once a handler is registered for that extension. Its native
  // handler compiles through the module's own `_compile`, so route rewrite targets through the prototype.
  const compileJs = Module._extensions['.js']

  for (const extension of ['.js', '.cjs']) {
    const compileExtension = Module._extensions[extension] ?? compileJs

    Module._extensions[extension] = function (module, filename) {
      if (getRewriteTarget(filename.replaceAll('\\', '/'))) {
        module._compile = Module.prototype._compile
      }
      return compileExtension.call(this, module, filename)
    }
  }
}
