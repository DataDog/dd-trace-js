// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default async function POST (req, res) {
  const body = req.body
  res.status(200).json({
    cache: 'no-store',
    data: body,
    query: req.query
  })
}
