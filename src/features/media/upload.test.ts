import { describe, it, expect } from 'vitest';
import { validateUpload, validateUploadMetadata, mediaKeyFor } from './upload';
import { mediaUrl } from './url';
import {
  REAL_IMAGES,
  PNG_1X1,
  SVG_WITH_SCRIPT,
  HTML_PAGE,
  fileOf,
} from '../../../test/helpers/image-bytes.mjs';

const file = (type: string, size: number, name = 'photo.png') =>
  new File([new Uint8Array(size)], name, { type });

/** A file of `size` bytes that really opens with a PNG header. */
const paddedPng = (size: number) =>
  fileOf(
    (() => {
      const bytes = new Uint8Array(size);
      bytes.set(PNG_1X1.subarray(0, Math.min(PNG_1X1.length, size)));
      return bytes;
    })(),
    { type: 'image/png', name: 'photo.png' },
  );

describe('validateUpload', () => {
  it('accepts the four supported raster types', async () => {
    for (const [type, bytes] of Object.entries(REAL_IMAGES)) {
      expect(await validateUpload(fileOf(bytes, { type }))).toBeNull();
    }
  });

  it('rejects SVG, which would execute script from the store origin', async () => {
    expect(await validateUpload(fileOf(SVG_WITH_SCRIPT, { type: 'image/svg+xml' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
  });

  it('rejects non-images', async () => {
    expect(await validateUpload(fileOf(HTML_PAGE, { type: 'application/pdf' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
  });

  it('rejects a file whose bytes disagree with its declared type', async () => {
    // The declared type is client-supplied: `-F 'files=@x.svg;type=image/png'`
    // is one flag away for anyone who can reach the endpoint.
    expect(await validateUpload(fileOf(SVG_WITH_SCRIPT, { type: 'image/png' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
    expect(await validateUpload(fileOf(HTML_PAGE, { type: 'image/jpeg' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
    // A real PNG announced as a real GIF is still a lie about what is stored.
    expect(await validateUpload(fileOf(PNG_1X1, { type: 'image/gif' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
  });

  it('rejects an empty file, which has no signature to agree with', async () => {
    expect(await validateUpload(fileOf(new Uint8Array(), { type: 'image/png' }))).toMatch(
      /JPEG|PNG|WebP|GIF/,
    );
  });

  it('rejects files over 5 MB', async () => {
    expect(await validateUpload(paddedPng(5 * 1024 * 1024 + 1))).toMatch(/5 Mo/);
    expect(await validateUpload(paddedPng(5 * 1024 * 1024))).toBeNull();
  });

  it('checks the size before reading any bytes', async () => {
    // The oversized file is refused on its declared size, so an upload that
    // could never be stored never costs a read.
    expect(validateUploadMetadata(file('image/png', 5 * 1024 * 1024 + 1))).toMatch(/5 Mo/);
    expect(validateUploadMetadata(file('image/svg+xml', 1024))).toMatch(/JPEG|PNG|WebP|GIF/);
  });
});

describe('mediaKeyFor', () => {
  it('namespaces under media/ with an extension matching the type', () => {
    expect(mediaKeyFor(file('image/webp', 1))).toMatch(/^media\/[0-9a-f]{20}\.webp$/);
    expect(mediaKeyFor(file('image/jpeg', 1))).toMatch(/^media\/[0-9a-f]{20}\.jpg$/);
  });

  it('never reuses a key, so /images/* can stay immutable', () => {
    const same = file('image/png', 1, 'same-name.png');
    expect(mediaKeyFor(same)).not.toBe(mediaKeyFor(same));
  });

  // Cloudflare's observability pipeline replaces any run of ID characters in a
  // request URL that reads like a credential — 32+ hex digits, or 21+ characters
  // mixing upper, lower and digits. A key above either line logs as
  // `/images/media/REDACTED.webp` and cannot be traced back to a file. This is
  // the guard against someone lengthening the key and quietly losing that.
  it('stays under the length Cloudflare redacts from request logs', () => {
    const id = mediaKeyFor(file('image/webp', 1)).slice('media/'.length).split('.')[0];
    expect(id.length).toBeLessThanOrEqual(20);
    expect(id).toMatch(/^[0-9a-f]+$/); // no uppercase: also below the base64 rule
  });
});

describe('mediaUrl', () => {
  it('serves through the Worker route by default', () => {
    expect(mediaUrl('media/abc.webp')).toBe('/images/media/abc.webp');
  });

  it('uses the configured image origin when one is set', () => {
    expect(mediaUrl('media/abc.webp', 'https://images.example.com')).toBe(
      'https://images.example.com/media/abc.webp',
    );
  });

  it('produces the same URL for legacy product keys', () => {
    expect(mediaUrl('products/old.jpg')).toBe('/images/products/old.jpg');
  });
});
