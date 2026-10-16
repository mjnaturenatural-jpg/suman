import { getSiteImage, type SiteImageKey } from '@/lib/site-images';
import type { CloudinaryTransform } from '@/lib/cloudinary';

interface SiteImageProps {
  k: SiteImageKey;
  alt?: string;
  className?: string;
  transforms?: CloudinaryTransform;
  eager?: boolean;
}

// Server component: resolves a Cloudinary-hosted site image by key.
// Returns null when the image is not configured so callers keep their default design.
export default async function SiteImage({ k, alt = '', className, transforms, eager = false }: SiteImageProps) {
  const src = await getSiteImage(k, transforms);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading={eager ? 'eager' : 'lazy'} />;
}
