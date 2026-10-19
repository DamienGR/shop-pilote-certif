import type { StorageProvider } from '../storage/provider.ts';
import { t } from '../i18n/index.ts';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ALLOWED = new Map<string, Set<string>>([
  ['application/pdf', new Set(['pdf'])],
  ['application/zip', new Set(['zip'])],
  ['application/epub+zip', new Set(['epub'])],
  ['audio/mpeg', new Set(['mp3'])],
  ['audio/mp4', new Set(['m4a'])],
  ['text/plain', new Set(['txt'])],
]);

export function validateDigitalFile(file: File): string | null {
  if (file.size < 1) return t('admin.products.error.fileEmpty');
  if (file.size > MAX_FILE_BYTES) return t('admin.products.error.fileTooLarge');
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED.get(file.type)?.has(ext)) {
    return t('admin.products.error.fileType');
  }
  return null;
}

export async function uploadDigitalFile(
  storage: StorageProvider,
  file: File,
): Promise<{ key: string; name: string; mime: string; size: number }> {
  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'download';
  const key = `deliverables/${crypto.randomUUID()}/${safeName}`;
  await storage.put(key, await file.arrayBuffer(), file.type || 'application/octet-stream', {
    cacheControl: 'private, no-store',
  });
  return { key, name: file.name, mime: file.type || 'application/octet-stream', size: file.size };
}
