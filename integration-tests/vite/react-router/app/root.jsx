import { Outlet, Scripts } from 'react-router'

export default function Root () {
  return (
    <html lang='en'>
      <head />
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  )
}
