export function sum (a, b) {
  const localVar = 10
  if (a > 10) {
    throw new Error('a is too large')
  }
  return a + b + localVar - localVar
}
