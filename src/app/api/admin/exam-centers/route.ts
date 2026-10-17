import { NextRequest, NextResponse } from 'next/server';
import { dbExecute, rowsToObjects, rowToObject } from '@/lib/db';
import { getAdminSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const email = await getAdminSession();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const result = await dbExecute(
      'SELECT id, name, enabled, sort_order, created_at FROM exam_centers ORDER BY sort_order ASC, name ASC'
    );
    return NextResponse.json(rowsToObjects(result), {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    });
  } catch (err: any) {
    console.error('[API /admin/exam-centers] GET error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to fetch exam centers' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const email = await getAdminSession();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const body = await request.json();
    const name = String(body.name || '').trim();
    const enabled = body.enabled === 0 || body.enabled === false ? 0 : 1;
    if (!name) {
      return NextResponse.json({ error: 'Exam center name is required' }, { status: 400 });
    }
    if (name.length > 160) {
      return NextResponse.json({ error: 'Exam center name is too long' }, { status: 400 });
    }

    const existing = await dbExecute('SELECT id FROM exam_centers WHERE name = ?', [name]);
    if (existing.rows && existing.rows.length > 0) {
      return NextResponse.json({ error: 'An exam center with this name already exists' }, { status: 400 });
    }

    const orderResult = await dbExecute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM exam_centers');
    const nextOrder = Number(rowToObject(orderResult)?.next) || 0;

    const inserted = await dbExecute(
      'INSERT INTO exam_centers (name, enabled, sort_order) VALUES (?, ?, ?)',
      [name, enabled, nextOrder]
    );

    console.log(`[ExamCenters] Admin ${email} created exam center "${name}"`);

    return NextResponse.json({ success: true, id: Number(inserted.lastInsertRowid), name, enabled, sort_order: nextOrder }, { status: 201 });
  } catch (err: any) {
    console.error('[API /admin/exam-centers] POST error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to create exam center' }, { status: 500 });
  }
}
