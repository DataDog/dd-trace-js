import fs from 'fs'

export async function getServerSideProps ({ query }) {
  return { props: { length: fs.readFileSync(query.file).length } }
}

export default function Page ({ length }) {
  return <main>{length}</main>
}
