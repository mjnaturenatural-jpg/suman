import { NextRequest, NextResponse } from 'next/server';
import { getAdminSession } from '@/lib/auth';
import { manualConfirmBooking } from '@/lib/manual-confirm';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const adminEmail = await getAdminSession();
    if (!adminEmail) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { booking_id } = await request.json();
    if (!booking_id) {
      return NextResponse.json({ error: 'booking_id is required' }, { status: 400 });
    }

    console.log(`[ManualConfirm] Admin ${adminEmail} confirming booking ${booking_id}`);

    const result = await manualConfirmBooking(booking_id, adminEmail);

    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.error || 'Manual confirmation failed',
      }, { status: result.status || 400 });
    }

    console.log(`[ManualConfirm] ✓ Booking ${booking_id} confirmed manually, serial=${result.serial_number}`);
    return NextResponse.json({
      success: true,
      booking_id,
      serial_number: result.serial_number,
    });
  } catch (err: any) {
    console.error('[ManualConfirm] Error:', err?.name, err?.message, err?.stack);
    return NextResponse.json({ error: 'Manual confirmation failed. Please try again.' }, { status: 500 });
  }
}
