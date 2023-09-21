// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default async function POST (req, res) {
  const body = req.body
  res.status(200).json({
    cache: 'no-store',
    data: body,
    query: req.query
  })
}

/*
import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';

export async function POST(request: NextRequest) {
    const body = await request.json()
    // console.log('ugaitz POST', arguments)
    return NextResponse.json({
        now: Date.now(),
        cache: 'no-store',
        data: {'apa': 'kaixo'}
    });
}

 */
