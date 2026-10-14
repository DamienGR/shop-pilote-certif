-- 0043: public IDs for the legal pages of 0040.
--
-- 0040 inserts the four legal pages after 0033 added `public_id`, and gives
-- them none. 0033 counts on scripts/backfill-public-ids.mjs for rows that lack
-- one, but nothing runs it on a store: provision, deploy and restore apply the
-- migrations and stop there. The admin then linked each page to
-- /admin/pages/null/edit, and none could be edited or published — found on a
-- real store during certification.
--
-- Generated in SQL, the way seed.sql gives its fixtures theirs: hex characters
-- are a subset of the Crockford alphabet, so ten of them (five random bytes)
-- make a valid token. The unique partial index from 0033 stays the collision
-- authority. Only NULL rows are touched: a store that ran the backfill script
-- keeps the IDs it already has.

UPDATE pages
SET public_id = 'page_' || lower(hex(randomblob(5)))
WHERE public_id IS NULL;
