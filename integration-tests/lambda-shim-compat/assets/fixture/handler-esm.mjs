import handlers from './handlers.cjs'
const raw = handlers.createHandler()
export const handler = process.env.COMPAT_CASE.includes('frozen') ? Object.freeze(raw) : raw
