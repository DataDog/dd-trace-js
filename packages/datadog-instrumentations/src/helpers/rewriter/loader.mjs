import { rewrite } from './index.js'

async function load (url, context, nextLoad) {
  const result = await nextLoad(url, context)

  result.source = rewrite(result.source, url, context.format)

  return result
}

export { load }
