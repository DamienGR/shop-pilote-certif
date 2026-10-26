-- 0046: the legal skeletons of 0040 no longer repeat their own title.
--
-- A content page prints its title above its body, and each of the four
-- skeletons opened on `# <title>`: the storefront showed every legal page's
-- title twice, two identical <h1>, and a merchant who wrote over the skeleton
-- kept the heading it started from — found on a real store during
-- certification (étape 11).
--
-- Only a body that still opens on exactly that heading AND still carries an
-- `[À COMPLÉTER` marker is touched: that is a skeleton nobody has finished,
-- which a production refuses to publish anyway. A text the merchant wrote has
-- no marker left and is never rewritten. Lengths are in characters, as SQLite
-- counts them for TEXT, so the accented titles cut where they should.

UPDATE pages
SET body_markdown = substr(body_markdown, length('# ' || title) + 3)
WHERE slug IN (
    'conditions-generales-de-vente',
    'mentions-legales',
    'politique-de-confidentialite',
    'droit-de-retractation'
  )
  AND substr(body_markdown, 1, length('# ' || title) + 2) = '# ' || title || char(10) || char(10)
  AND instr(body_markdown, '[À COMPLÉTER') > 0;
