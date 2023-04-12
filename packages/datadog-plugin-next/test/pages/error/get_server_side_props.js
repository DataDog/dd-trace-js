export async function getServerSideProps (ctx) {
  throw new Error('fail')
}

export default function GetServerSideProps () {
  return (
    <div>
      Get Server Side Props!
    </div>
  )
}
