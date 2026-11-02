/**
 * @param {string} name
 */
export function normalizeMatrixJobName (name) {
  if (!name.endsWith(')')) return name

  let depth = 0

  for (let i = name.length - 1; i >= 0; i--) {
    if (name[i] === ')') {
      depth++
    } else if (name[i] === '(' && --depth === 0 && name[i - 1] === ' ') {
      return name.slice(0, i - 1)
    }
  }

  return name
}
