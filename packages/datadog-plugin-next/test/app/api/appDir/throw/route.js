// Opt out of static prerendering so `next build` does not execute (and fail on) the throw.
export const dynamic = 'force-dynamic'

export async function GET () {
  throw new Error('thrown app dir error')
}
