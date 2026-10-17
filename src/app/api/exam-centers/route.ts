import { NextResponse } from 'next/server';
import { dbExecute, rowsToObjects } from '@/lib/db';
import { EXAM_CENTERS } from '@/lib/slots';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const result = await dbExecute(
      'SELECT name FROM exam_centers WHERE enabled = 1 ORDER BY sort_order ASC, name ASC'
    );
    const names = rowsToObjects(result)
      .map((r) => String(r.name || '').trim())
      .filter(Boolean);
    // Fall back to the built-in list if the table is empty, so the booking
    // flow always has centres to show even before an admin adds any.
    return NextResponse.json(names.length > 0 ? names : EXAM_CENTERS, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  } catch (err: any) {
    console.error('[API /exam-centers] GET error:', err?.message || err);
    return NextResponse.json(EXAM_CENTERS, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  }
}
