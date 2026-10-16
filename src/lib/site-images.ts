import { dbExecute } from '@/lib/db';
import { cloudinaryUrl, getCloudinaryConfig, type CloudinaryTransform } from '@/lib/cloudinary';

// Site imagery hosted on Cloudinary. Public ids are stored in the `settings`
// table (admin-editable) so no code change is needed to swap an image.
// A key resolves to `null` when it is unset or Cloudinary is not configured,
// and callers fall back to the default design.

export type SiteImageKey =
  | 'hero'
  | 'service_exam_travel'
  | 'service_group_booking'
  | 'service_scheduled_slots'
  | 'service_fast_booking';

const SETTINGS_KEYS: Record<SiteImageKey, string> = {
  hero: 'img_hero',
  service_exam_travel: 'img_service_exam_travel',
  service_group_booking: 'img_service_group_booking',
  service_scheduled_slots: 'img_service_scheduled_slots',
  service_fast_booking: 'img_service_fast_booking',
};

let cache: Record<string, string> | null = null;

async function loadSettings(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    const result = await dbExecute('SELECT key, value FROM settings');
    const map: Record<string, string> = {};
    for (const row of result.rows as any[]) {
      if (row && row.key) map[row.key] = row.value ?? '';
    }
    cache = map;
  } catch {
    cache = {};
  }
  return cache;
}

/** Invalidate the settings cache (call after saving settings). */
export function invalidateSiteImageCache(): void {
  cache = null;
}

/** Resolve a site image to a Cloudinary URL, or null when not configured. */
export async function getSiteImage(
  key: SiteImageKey,
  transforms: CloudinaryTransform = {}
): Promise<string | null> {
  if (!getCloudinaryConfig()) return null;
  const settings = await loadSettings();
  const publicId = (settings[SETTINGS_KEYS[key]] || '').trim();
  if (!publicId) return null;
  try {
    return cloudinaryUrl(publicId, transforms);
  } catch {
    return null;
  }
}
