import type { TypedInput } from './types'

import { typedBranch } from './ts-branch'
import { typedShared } from './ts-shared'

export function buildTypedLabel (input: TypedInput): string {
  return `${input.name}:${typedShared()}:${typedBranch(input.count)}`
}
