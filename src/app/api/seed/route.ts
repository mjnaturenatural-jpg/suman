import { NextRequest, NextResponse } from 'next/server';
import { dbExecute } from '@/lib/db';
import { hashPassword } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const expected = process.env.ADMIN_SEED_SECRET;
    if (!expected) {
      return NextResponse.json({ error: 'Seeding is not configured' }, { status: 503 });
    }
    const provided = request.headers.get('x-admin-seed-secret') || '';
    if (provided !== expected) {
      return NextResponse.json({ error: 'Invalid seed secret' }, { status: 401 });
    }

    const adminEmail = process.env.ADMIN_EMAIL || 'admin@sumantravels.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    const existing = await dbExecute('SELECT id FROM admin WHERE email = ?', [adminEmail]);
    if (existing.rows.length > 0) {
      return NextResponse.json({ message: 'Admin already exists' });
    }

    const passwordHash = await hashPassword(adminPassword);
    await dbExecute('INSERT INTO admin (email, password_hash) VALUES (?, ?)', [adminEmail, passwordHash]);

    return NextResponse.json({ message: 'Admin created successfully' });
  } catch (err: any) {
    console.error('[API /seed] POST error:', err?.message || err);
    const msg = err?.message || String(err || 'Unknown error');
    return NextResponse.json({ error: 'Seed failed', detail: msg }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { Allow: 'POST' } });
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
}
