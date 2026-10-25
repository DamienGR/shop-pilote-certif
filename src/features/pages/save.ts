import type { D1Database } from '@cloudflare/workers-types';
import { t, tn } from '../i18n/index.ts';
import { findMediaByKeys, pageMediaClaimStatements } from '../media/db.ts';
import { isIncomplete } from './completeness.ts';
import { extractMediaKeys } from './markdown.ts';
import { type Page } from './db.ts';

export interface SaveResult {
  /** Keys the body references that are not in the media library. */
  unresolved: string[];
  /** True when a requested publish was refused: media missing, or markers left. */
  publishRefused: boolean;
  /** The body still holds `[À COMPLÉTER]` markers, in an environment that refuses them live. */
  incomplete: boolean;
  /** The publication state actually stored. */
  published: number;
}

/**
 * Persist a page body and rebuild its media associations, atomically.
 *
 * Unresolved media never costs the author their work: the text is always saved.
 * What it blocks is a DRAFT going live with images that would render broken.
 * An already-published page is left published — silently unpublishing a live
 * page because one image went missing is a far worse outcome than one broken
 * image the admin is warned about.
 *
 * The claims and the publish decision go in ONE batch, which D1 runs as a
 * transaction. Writing them separately left a race: media deleted after the
 * lookup but before the claims landed would be skipped silently, and the page
 * had already been published by then. Here the UPDATE decides `published` from
 * a COUNT of the rows the same transaction just claimed, so a claim that lost
 * to a concurrent delete refuses the draft-to-live transition instead.
 *
 * `refuseIncomplete` (a production, ./completeness.ts) treats a body that still
 * holds the skeleton's `[À COMPLÉTER]` markers the same way: saved, kept a
 * draft, and a live page left live. Demoting a published terms page would
 * reopen the checkout without consent, which is worse than a marker.
 */
export async function savePageBody(
  db: D1Database,
  existing: Page,
  fields: {
    title: string;
    slug: string;
    body_markdown: string;
    published: number;
    layout: string;
  },
  options: { baseUrl?: string; refuseIncomplete?: boolean } = {},
): Promise<SaveResult> {
  const referenced = extractMediaKeys(fields.body_markdown, { baseUrl: options.baseUrl });
  const resolved = await findMediaByKeys(db, referenced);
  const resolvedKeys = new Set(resolved.map((m) => m.image_key));
  const unresolved = referenced.filter((key) => !resolvedKeys.has(key));

  const incomplete = options.refuseIncomplete === true && isIncomplete(fields.body_markdown);

  // Publishing is refused when media is missing or markers are left, but an
  // explicit unpublish is always honoured and a live page is never demoted.
  const wantsPublish = fields.published === 1;
  const blockedValue = wantsPublish ? existing.published : 0;
  const okValue = unresolved.length === 0 && !incomplete ? fields.published : blockedValue;

  await db.batch([
    ...pageMediaClaimStatements(
      db,
      existing.id,
      resolved.map((m) => m.id),
    ),
    db
      .prepare(
        `UPDATE pages
            SET title = ?2,
                slug = ?3,
                body_markdown = ?4,
                layout = ?5,
                published = CASE
                  WHEN (SELECT COUNT(*) FROM page_media WHERE page_id = ?1) = ?6
                  THEN ?7 ELSE ?8 END,
                updated_at = datetime('now')
          WHERE id = ?1`,
      )
      .bind(
        existing.id,
        fields.title,
        fields.slug,
        fields.body_markdown,
        fields.layout,
        resolved.length,
        okValue,
        blockedValue,
      ),
  ]);

  // Read back what the transaction actually stored rather than assuming.
  const saved = await db
    .prepare('SELECT published FROM pages WHERE id = ?')
    .bind(existing.id)
    .first<{ published: number }>();
  const published = saved?.published ?? blockedValue;

  return {
    unresolved,
    publishRefused: wantsPublish && published !== 1,
    incomplete,
    published,
  };
}

/** Admin-facing summary of what happened, or '' when everything resolved. */
export function saveWarning(result: SaveResult): string {
  const warnings: string[] = [];
  if (result.incomplete && result.published === 1) {
    warnings.push(t('admin.pages.save.incompleteLive'));
  } else if (result.incomplete && result.publishRefused) {
    warnings.push(t('admin.pages.save.incompleteRefused'));
  }
  const media = mediaWarning(result);
  if (media) warnings.push(media);
  return warnings.join(' ');
}

function mediaWarning(result: SaveResult): string {
  // A refusal the markers alone explain is not a media problem.
  const refusedForMedia =
    result.publishRefused && !(result.incomplete && result.unresolved.length === 0);
  if (result.unresolved.length === 0 && !refusedForMedia) return '';
  const count = Math.max(result.unresolved.length, 1);
  if (refusedForMedia) {
    return tn('admin.pages.save.publishRefused.one', 'admin.pages.save.publishRefused.other', count);
  }
  if (result.published === 1) {
    return tn('admin.pages.save.liveBroken.one', 'admin.pages.save.liveBroken.other', count);
  }
  return tn('admin.pages.save.draftMissing.one', 'admin.pages.save.draftMissing.other', count);
}
