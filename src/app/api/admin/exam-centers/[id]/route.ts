import { NextRequest, NextResponse } from 'next/server';
import { dbExecute } from '@/lib/db';
import { getAdminSession } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getAdminSession();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id } = await params;
    const centerId = Number(id);
    if (!centerId || isNaN(centerId)) {
      return NextResponse.json({ error: 'Invalid exam center ID' }, { status: 400 });
    }

    const existing = await dbExecute('SELECT id, name, enabled, sort_order FROM exam_centers WHERE id = ?', [centerId]);
    if (!existing.rows || existing.rows.length === 0) {
      return NextResponse.json({ error: 'Exam center not found' }, { status: 404 });
    }

    const body = await request.json();
    const current = existing.rows[0] as any;

    const name = body.name != null ? String(body.name).trim() : String(current.name);
    if (!name) {
      return NextResponse.json({ error: 'Exam center name is required' }, { status: 400 });
    }
    if (name.length > 160) {
      return NextResponse.json({ error: 'Exam center name is too long' }, { status: 400 });
    }

    if (name !== current.name) {
      const clash = await dbExecute('SELECT id FROM exam_centers WHERE name = ? AND id != ?', [name, centerId]);
      if (clash.rows && clash.rows.length > 0) {
        return NextResponse.json({ error: 'An exam center with this name already exists' }, { status: 400 });
      }
    }

    const enabled =
      body.enabled === undefined
        ? Number(current.enabled)
        : body.enabled === 0 || body.enabled === false
          ? 0
          : 1;
    const sortOrder =
      body.sort_order === undefined || body.sort_order === null || isNaN(Number(body.sort_order))
        ? Number(current.sort_order)
        : Number(body.sort_order);

    await dbExecute(
      'UPDATE exam_centers SET name = ?, enabled = ?, sort_order = ? WHERE id = ?',
      [name, enabled, sortOrder, centerId]
    );

    console.log(`[ExamCenters] Admin ${email} updated exam center #${centerId} ("${name}", enabled=${enabled})`);
    return NextResponse.json({ success: true, id: centerId, name, enabled, sort_order: sortOrder });
  } catch (err: any) {
    console.error('[API /admin/exam-centers/:id] PUT error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to update exam center' }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getAdminSession();
  if (!email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { id } = await params;
    const centerId = Number(id);
    if (!centerId || isNaN(centerId)) {
      return NextResponse.json({ error: 'Invalid exam center ID' }, { status: 400 });
    }

    const existing = await dbExecute('SELECT id, name FROM exam_centers WHERE id = ?', [centerId]);
    if (!existing.rows || existing.rows.length === 0) {
      return NextResponse.json({ error: 'Exam center not found' }, { status: 404 });
    }

    await dbExecute('DELETE FROM exam_centers WHERE id = ?', [centerId]);

    const name = (existing.rows[0] as any).name;
    console.log(`[ExamCenters] Admin ${email} deleted exam center #${centerId} ("${name}")`);
    return NextResponse.json({ success: true, message: 'Exam center deleted' });
  } catch (err: any) {
    console.error('[API /admin/exam-centers/:id] DELETE error:', err?.message || err);
    return NextResponse.json({ error: 'Failed to delete exam center' }, { status: 500 });
  }
}
