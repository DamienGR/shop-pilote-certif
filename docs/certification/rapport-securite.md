# Rapport de sécurité — certification, étape 5

Livrable du jalon 10 (`docs/certification/plan.md`, étape 5), ligne par ligne
du §8.4 du plan d'implémentation.

- **Boutique** : `pilote-certif`, staging du compte A, derrière Access
  (`preview.studiomaestro.fr`), administration en mode mot de passe.
- **Socle** : `v0.3.4`, monté en tête de l'étape (pull request #10 de la
  boutique) et déployé avec la migration 0043 ; puis `v0.3.5` pour la ligne des
  limiteurs (pull request #12), déployé avec la migration 0044.
- **Passage** : les 2026-10-14 et 2026-10-15, par l'opérateur, selon
  `docs/certification/etape-5-commandes.md` ; Stripe en mode test, e-mails
  réels vers une boîte de test, jeton de service Access créé pour l'étape puis
  révoqué, et un second pour la porte de `v0.3.5`, révoqué aussi.
- **Preuves** : `client/certification/etape-5/` du dépôt
  [`shop-pilote-certif`](https://github.com/DamienGR/shop-pilote-certif/tree/main/client/certification/etape-5)
  (pull requests #11, puis #13 pour les limiteurs). Les noms de fichiers
  ci-dessous y renvoient.

## Verdict

Les neuf lignes tiennent sur la boutique déployée. La neuvième, **rate limits
actifs**, ouverte en `v0.3.4`, s'est fermée en `v0.3.5`. En `v0.3.4`, les trois
limiteurs existaient et répondaient sans erreur, mais celui de Cloudflare
comptait trop large pour arrêter un essai patient de mots de passe. En
`v0.3.5`, la boutique compte elle-même les tentatives de connexion, et la porte
l'a vue refuser la sixième. La production de l'étape 9 n'a pas Access devant
son administration : la même porte s'y rejoue.

## Les neuf lignes

| Ligne du §8.4 | État | Ce qui a été mesuré | Preuve |
|---|---|---|---|
| aucune vulnérabilité critique ou élevée non justifiée | tenue | `npm audit` racine (487 dépendances) et `mcp/` (229) : zéro, toutes sévérités, outils de développement compris. Les deux alertes élevées de `sharp` 0.35.2 sous `miniflare`, vues en répétition, sont levées par `v0.3.4` | `audit-racine.json`, `audit-mcp.json` |
| aucune clé dans Git, les logs ou les artefacts | tenue | arbre et build verts ; tout l'historique (1 865 blobs, 399 commits, 79 refs, têtes de pull request comprises) vert avec la règle corrigée — rouge en `v0.3.4` sur un faux positif, voir « Défauts » ; aucun secret dans ce que la boutique écrit pendant 531 événements ; ni clé ni adresse dans les journaux et artefacts des deux `Nightly` d'après la montée | `historique-v0.3.4.txt`, `historique-regle-corrigee.txt`, `journaux.json`, `nightly.txt` |
| webhooks signés | tenue | un événement non signé, puis mal signé, posté à travers le contournement d'Access sans jeton de service : refusé par le Worker. Les événements signés passent et se rejouent sans seconde commande (étape 4) | `porte-distante.txt` ; étape 4, `une-commande-par-session.json` |
| routes admin protégées | tenue | 37 routes dérivées des fichiers refusées sur chaque verbe sans session ; assistant d'installation fermé ; une assertion Access forgée n'ouvre rien ; une API d'administration ne dit rien de ce qu'elle protège ; hors du webhook, la preview reste privée | `porte-distante.txt` |
| rate limits actifs | tenue en `v0.3.5` | en `v0.3.5`, 18 contrôles sur 18 : la recherche refuse dans ses 250 premières requêtes et le checkout dans ses 100 premières, 50 à la fois (plafonds : 1 200 et 400) ; la connexion refuse la sixième tentative du passage, par le compteur exact, avec un `Retry-After` au-delà de la minute de Cloudflare et d'au plus un quart d'heure, sans cookie ; une seule ligne en base, à six tentatives. En `v0.3.4` : liaisons présentes, aucune erreur de limiteur, mais aucun 429 en trois fois la limite, tirée par rafales de dix, sur la recherche (180), le checkout (60) et la connexion (30) ; 232 recherches une par une en 70 s, toutes servies, pour 60 par minute ; 1 000 recherches, 50 en parallèle : premier 429 après environ 450, 325 refus au total | `porte-distante-v0.3.5.txt`, `deploy-v0.3.5.json` ; en `v0.3.4`, `porte-distante-limiteurs.txt`, `diag-limiteur.txt`, `diag-limiteur-lourd.txt` |
| uploads contrôlés | tenue | dans l'administration, un faux PNG refusé sur son type, un PNG de plus de 5 Mo refusé sur sa taille, une vraie photo acceptée puis supprimée ; une image du catalogue servie en `image/png` avec `x-content-type-options: nosniff`. Le SVG et le faux type MIME sont aussi refusés à chaque commit par la porte locale | `README.md` des preuves, « La commande E » |
| CSP et en-têtes présents | tenue, sous dérogation | durcissement complet sur chaque classe de réponse du Worker et sur les actifs statiques servis avant lui ; un 500 est durci, non mis en cache, sans pile. `script-src` et `style-src` restent sous la dérogation écrite du plan (§6) | `porte-distante.txt` |
| aucune donnée de carte traitée par l'application | tenue | aucun champ de carte sur les pages de la boutique, du catalogue au paiement ; le paiement se fait sur la page de Stripe ; aucune colonne de carte dans les 43 migrations | `porte-distante.txt` ; `migrations/` |
| aucune PII inutile dans les logs | tenue | capture `wrangler tail` de 531 événements, sans échantillonnage, pendant la commande E, son remboursement, son expédition et la porte : rien dans ce que la boutique écrit ni dans les 526 URL, nom et rue inventés compris. La trace du webhook qui a enregistré E, dans Observability : requêtes D1 en `?`, ni nom, ni rue, ni adresse | `journaux.json`, `commande-e.json` ; la trace, décrite dans le `README.md` des preuves |

## Ce que le relevé des journaux rapporte sans le juger

Le relevé classe à part ce que la plateforme écrit autour d'une requête. Jugé
ici :

- **`cf.tlsExportedAuthenticator`** (298 requêtes) : des empreintes
  hexadécimales de la poignée de main TLS, posées par l'edge de Cloudflare,
  propres à chaque connexion. Pas un secret de la boutique, rien de
  réutilisable.
- **`cf-access-authenticated-user-email`, `cf-access-jwt-assertion`** :
  l'identité de l'opérateur derrière la preview. Ils arrivent déjà `REDACTED`
  dans la capture, masqués par la plateforme. La production n'a pas d'Access.
- **les trois lignes que la boutique a écrites** : deux `unhandled_error` sur
  `POST /api/cart`, le 500 que la porte provoque exprès, au message générique ;
  une exception sur un `HEAD` d'image, défaut corrigé (ci-dessous).

## Défauts trouvés

| Défaut | Trouvé | Effet | État |
|---|---|---|---|
| les limiteurs de Cloudflare comptent par localisation et par machine, et laissent passer un essai patient | en réel | un essai patient sur la connexion à l'administration de production, sans Access, ne bute que sur Turnstile s'il est activé et sur le coût du hachage (PBKDF2, 100 000 itérations) ; la recherche et le checkout restent protégés d'une inondation | compteur exact des tentatives de connexion (migration 0044) et porte recalibrée, en `v0.3.5` ; rejoué contre le staging, 18 sur 18 (#13 de la boutique) |
| `shopctl` recopiait le nom du compte Cloudflare, « <adresse>'s Account » | en répétition | l'adresse de connexion de l'opérateur publiée dans cinq rapports de l'étape 3, et dans les journaux et artefacts du `Nightly`, publics | masquée à la source en `v0.3.4` (#65) ; rapports masqués dans la boutique, journaux et artefacts des anciens `Nightly` supprimés |
| `sharp` 0.35.2 sous `miniflare` | en répétition | deux alertes élevées de `npm audit`, dans un outil de test | forcé en 0.35.5, `v0.3.4` (#65) |
| un JWT d'exemple signé « sig », commité par un test du socle puis retiré | en réel | `check:secrets:history` rouge sur toute boutique en `v0.3.4` | la règle exige une signature de vraie longueur (#67) |
| chaque `HEAD` d'image levait une exception de l'API Cache | en réel | une ligne d'erreur par requête ; la réponse restait un 200 | le `HEAD` ne passe plus par le cache (#67) |
| `deploy` s'arrêtait dans le shell de la fiche : un test héritait de `CLOUDFLARE_ACCOUNT_ID`, un autre de `core.autocrlf` | en réel | outillage, pas une faille ; rien téléversé | tests indépendants du poste (#67) |

Les corrections de la #67 sont parties avec `v0.3.5`, que `deploy` a mise sur
le staging sans contournement, `CLOUDFLARE_ACCOUNT_ID` exporté et
`core.autocrlf=true` sur le poste.

## Ce que le compteur ne fait pas

Il compte par réseau client : une adresse IPv4, un /64 IPv6. Juste après la
porte, l'opérateur est entré dans l'administration du staging, et c'était
attendu à double titre. Sa session du matin était encore valable : le compteur
refuse de nouvelles tentatives, il ne ferme pas une session ouverte. Et son
navigateur sort en IPv6, alors que le terminal qui a lancé la porte ne sort
qu'en IPv4 : deux réseaux, deux budgets. Qui tient beaucoup de réseaux en a
autant de budgets ; un compteur par réseau ne s'en défend pas, et un compteur
unique pour toute la boutique laisserait n'importe qui bloquer le commerçant.
Restent, devant ce cas, Turnstile, quand il est activé, et le coût du hachage.

## Risque accepté

L'adresse de connexion à Cloudflare de l'opérateur reste dans l'**historique**
public de `shop-pilote-certif`, dans les commits d'avant le masquage des
rapports de l'étape 3. Décision du 2026-10-14 : pas de réécriture. Elle
casserait chaque clone sans retirer l'adresse de ceux déjà faits. C'est
l'adresse de l'opérateur, pas celle d'un acheteur, et le run `Nightly` que
l'étape 3 cite est archivé hors du dépôt.

## Comment la ligne s'est fermée

1. `v0.3.5` : un compteur exact des échecs de connexion, que la porte locale
   éprouve, et la porte distante recalibrée sur ce que le limiteur de
   Cloudflare garantit vraiment. Fait ;
2. la boutique montée en `v0.3.5`, puis
   `BASE_URL=… npm run test:security:remote -- --limiteurs` contre le staging.
   Fait le 2026-10-15 : 18 contrôles sur 18 ;
3. la même porte contre la production, à l'étape 9, puisque c'est elle qui n'a
   pas Access. Reste à faire : c'est une case de l'étape 9 du plan.
