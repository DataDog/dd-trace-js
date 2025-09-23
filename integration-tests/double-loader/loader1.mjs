import { readFile } from 'node:fs/promises'

export async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (result.format === 'commonjs' && !result.source) {
    result.source = await readFile(new URL(url))
  }
  return result
}
