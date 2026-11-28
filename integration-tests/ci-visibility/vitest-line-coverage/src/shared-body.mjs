import { add } from './arithmetic.ts'

export function sharedBody () {
  if (add(1, 2) !== 3) throw new Error('1 + 2 is not 3')
}
