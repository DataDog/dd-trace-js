// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default async function POST (req, res) {
  res.setHeader('authorization', 'header-value-1')
  res.setHeader('proxy-authorization', 'header-value-2')
  res.setHeader('www-authenticate', 'header-value-4')
  res.setHeader('proxy-authenticate', 'header-value-5')
  res.setHeader('authentication-info', 'header-value-6')
  res.setHeader('proxy-authentication-info', 'header-value-7')
  res.setHeader('cookie', 'header-value-8')
  res.setHeader('set-cookie', 'header-value-9')

  const body = req.body
  res.status(200).json({
    cache: 'no-store',
    data: body
  })
}
