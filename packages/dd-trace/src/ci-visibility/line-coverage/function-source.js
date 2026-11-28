'use strict'

// Some code reads a function's source to evaluate it somewhere else: a worker that evals it (webpack's
// minimizer, workerpool), a browser page (Puppeteer and Playwright `evaluate`), generated code (bundler
// runtime templates). The probes of an instrumented function refer to variables of the module it was
// instrumented in, which do not exist there, so Function.prototype.toString leaves them out.
//
// The instrumenter puts every probe list right after `;`, `{`, `(` or `,` and right before `;`, `,` or
// `)`. Insertions that carry their own delimiters are removed whole, which gives back the original text.
// Elsewhere the list goes with one separator, which leaves the parentheses or braces that grouped it:
// the code is equivalent, not identical.

// A touch, word updates, or both.
const LIST = String.raw`\$dd\d*\$(?:t\|\|\$dd\d*\$r\(\)|r\(\)|\d+\|=\d+)(?:,\$dd\d*\$\d+\|=\d+)*`

const REMOVALS = [
  // `;probes;` before a statement
  [new RegExp(`;${LIST};`, 'g'), ''],
  // `($dd$a(expression,probes))`, which runs probes after the expression
  [/\(\$dd\d*\$a\(/g, ''],
  [new RegExp(String.raw`,${LIST}\)\)`, 'g'), ''],
  // `$dd$d0=(probes,void 0),` before a declarator
  [new RegExp(String.raw`\$dd\d*\$d\d+=\(${LIST},void 0\),`, 'g'), ''],
  // `;#$dd$f0=(probes,void 0);` before a class field
  [new RegExp(String.raw`;(?:static )?#\$dd\d*\$f\d+=\(${LIST},void 0\);`, 'g'), ''],
  // `name:(probes,name)` for a shorthand property
  [new RegExp(String.raw`(?<![$\p{ID_Continue}])([$\p{ID_Continue}]+):\(${LIST},\1\)`, 'gu'), '$1'],
  [new RegExp(String.raw`\["__proto__"\]:\(${LIST},__proto__\)`, 'g'), '__proto__'],
  // The rest: `(probes,` and `{probes;`. The lookahead keeps a list from ending before its last word.
  [new RegExp(String.raw`(?<=[({])${LIST}(?!,\$dd\d*\$\d)[,;]`, 'g'), ''],
]

/** @type {WeakSet<Function>} */
const replacements = new WeakSet()

/**
 * @param {string} source the source of an instrumented function
 */
function removeProbes (source) {
  for (const [pattern, replacement] of REMOVALS) source = source.replace(pattern, replacement)
  return source
}

/**
 * Makes Function.prototype.toString of the realm of `globalObject` give the source of instrumented
 * functions without their probes.
 *
 * @param {object} globalObject
 */
function showOriginalFunctionSource (globalObject) {
  const prototype = globalObject.Function?.prototype
  const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, 'toString')
  const toString = descriptor?.value
  if (typeof toString !== 'function' || replacements.has(toString)) return
  const replacement = {
    toString () {
      // Looks like the built-in it replaces, as core-js's replacement does.
      if (replacements.has(this)) return toString.call(toString)
      const source = toString.call(this)
      return source.includes('$dd') ? removeProbes(source) : source
    },
  }.toString
  replacements.add(replacement)
  // The replacement is a function of this realm, so its own toString would otherwise be the one of this realm.
  Object.defineProperty(replacement, 'toString', { ...descriptor, value: replacement })
  Object.defineProperty(prototype, 'toString', { ...descriptor, value: replacement })
}

module.exports = { removeProbes, showOriginalFunctionSource }
