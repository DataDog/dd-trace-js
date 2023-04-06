export async function getServerSideProps (ctx) {
  return {
    notFound: true
  }
}

export default function NotFound () {
  return (
    <div>
      Not found!
    </div>
  )
}
