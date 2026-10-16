// Cloudinary image hosting for general site imagery (hero, service cards, banners).
//
// Images are *served* by building res.cloudinary.com URLs, so no SDK is needed
// to display them. Signed uploads require CLOUDINARY_API_KEY + API_SECRET;
// unsigned uploads require CLOUDINARY_UPLOAD_PRESET.

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  uploadPreset?: string;
}

export interface CloudinaryTransform {
  width?: number;
  height?: number;
  crop?: string;
  quality?: number | 'auto';
  format?: string | 'auto';
}

let cachedConfig: CloudinaryConfig | null | undefined;

export function getCloudinaryConfig(): CloudinaryConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) {
    cachedConfig = null;
    return null;
  }
  cachedConfig = {
    cloudName,
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || undefined,
  };
  return cachedConfig;
}

/** Build a Cloudinary delivery URL for a public id, with optional transformations. */
export function cloudinaryUrl(publicId: string, options: CloudinaryTransform = {}): string {
  const cfg = getCloudinaryConfig();
  if (!cfg) {
    throw new Error('Cloudinary is not configured (CLOUDINARY_CLOUD_NAME is missing)');
  }
  const parts = ['image/upload'];

  const transforms: string[] = [];
  if (options.width) transforms.push(`w_${options.width}`);
  if (options.height) transforms.push(`h_${options.height}`);
  if (options.crop) transforms.push(`c_${options.crop}`);
  transforms.push(`q_${options.quality ?? 'auto'}`);
  transforms.push(`f_${options.format ?? 'auto'}`);
  if (transforms.length) parts.push(transforms.join(','));

  parts.push(publicId);
  return `https://res.cloudinary.com/${cfg.cloudName}/${parts.join('/')}`;
}
