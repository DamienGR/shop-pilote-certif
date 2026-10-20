# Rapport de performance — certification, étape 6

Livrable du jalon 10 (`docs/certification/plan.md`, étape 6) : accessibilité,
navigateurs et performance de la boutique déployée, §8.5 du plan
d'implémentation compris.

- **Boutique** : `pilote-certif`, staging du compte A, derrière Access
  (`preview.studiomaestro.fr`), thème `pilote-certif` (dérivé d'atelier),
  catalogue témoin de vingt produits.
- **Socle** : `v0.3.8`, monté depuis `v0.3.5` en tête de l'étape (pull request
  #15 de la boutique) et déployé avec la migration 0045 ; puis `v0.3.9` pour
  ce que l'étape a trouvé (pull request #17), sans migration. `v0.3.9` ne
  change que la CSS de la prose et l'outillage : les mesures de CPU, de charge
  et de Lighthouse prises en `v0.3.8` valent pour elle, et seule la porte
  navigateur a été rejouée.
- **Passage** : le 2026-10-19, selon `docs/certification/etape-6-commandes.md`.
  Stripe en mode test, jeton de service Access créé pour l'étape puis révoqué.
  Les visites à froid, l'administration, l'INP et la dernière unité ont été
  passés par des scripts Playwright, hors du dépôt, à travers ce jeton.
- **Preuves** : `client/certification/etape-6/` du dépôt
  [`shop-pilote-certif`](https://github.com/DamienGR/shop-pilote-certif/tree/main/client/certification/etape-6)
  (pull request #18). Les noms de fichiers ci-dessous y renvoient.

## Verdict

Quatre lignes sur cinq tiennent. La porte navigateur, rouge en `v0.3.8` sur
le contraste de la page CGV, est verte en `v0.3.9`. Lighthouse dépasse 90
partout, la charge passe sans une erreur, et la dernière unité ne se vend
qu'une fois. Reste ouverte la ligne des **parcours d'achat à la main** : une
commande payée sur les quatre navigateurs demandés.

Le CPU n'est pas une ligne du plan mais la question que l'étape devait
trancher. À chaud, la vitrine tient sous 10 ms en médiane ; à froid, elle les
dépasse de trois à cinq fois sur la première requête de chaque route, et
Cloudflare n'a arrêté aucune invocation. Les trois issues sont posées
ci-dessous ; le choix revient à Damien.

## Les lignes

| Ligne du plan | État | Ce qui a été mesuré | Preuve |
|---|---|---|---|
| porte navigateur contre le staging (§8.5) | tenue en `v0.3.9` | en `v0.3.8`, 83 passés et 2 échecs : axe sur la page CGV, le bandeau « Brouillon » à 4,37:1 sur le papier du thème et 4,43:1 dans son `code`. En `v0.3.9`, 85 passés, 5 sautés avec leur raison (signature du design ×2, catalogue vide ×2, menu replié sur desktop) ; la citation mesurée à 7,06:1, son code à 6,41:1. Le menu d'en-tête porte trois liens, et son test clavier tourne sur téléphone | `porte-navigateur.txt`, `porte-navigateur-v0.3.9.txt` |
| parcours d'achat à la main, quatre navigateurs | **ouverte** | passés à la main par Damien sans relevé sur le moment ; l'administration ne montre qu'une commande payée ce jour-là, #6 (`ord_r0rgn4xrwc`). Rien de cassé signalé | `README.md` des preuves |
| Lighthouse mobile ≥ 90, LCP, CLS, INP relevés | tenue | 100 / 100 / 92 sur l'accueil, une catégorie, une fiche et le panier garni ; LCP 1,0 à 1,6 s, CLS 0, TBT 0 ms ; aucune requête hors de la boutique. INP 24 ms | `lighthouse-*.report.json`, `lighthouse-*.report.html` |
| charge de quinze minutes, aucune erreur, consommation relevée | tenue | vingt acheteurs, 6 528 requêtes (7,1 par seconde), 0 erreur, 0 réponse 429 ; p99 de 245 à 311 ms selon l'étape du parcours. Monitor sur trois heures, la charge comprise : 0 erreur sur 7 307 requêtes, 0 invocation arrêtée, D1 à 16 % du quota quotidien en lecture | `charge.json`, `monitor.json` |
| cinq checkouts concurrents sur la dernière unité | tenue | une session Stripe, quatre `409`, stock à 0 ; l'unité revenue à l'expiration de la session, le stock remis | `derniere-unite.txt` |

Le SEO perd ses huit points sur un seul audit, `robots-txt`. Lighthouse lit
`/robots.txt` sans les en-têtes qu'on lui passe, reçoit la page de connexion
d'Access et la juge invalide ; celui de la boutique est valide. Hors preview
privée, le SEO serait à 100.

L'INP a été mesuré par script plutôt que dans le panneau de DevTools : Pixel 7
émulé, CPU ralenti 4× par CDP, l'Event Timing API relevée sur la page, la pire
de trois interactions retenue (variante changée deux fois, menu ouvert sur la
fiche et sur le panier). L'ajout au panier, qui ouvre le tiroir, est passé
sous les 16 ms que l'Event Timing rapporte.

## Le CPU

À froid, la première requête de chaque route juste après le déploiement
(`cpu-froid.txt`) :

| Route | CPU à froid |
|---|---|
| `GET /` | 53 ms |
| `POST /admin/login` | 45 ms, le hachage du mot de passe, voulu |
| `GET /categories/:slug` | 40 ms |
| `GET /products/:slug` | 35 ms |
| `GET /admin/settings` | 32 ms |
| `GET /admin` | 19 ms |
| `GET /cart` | 18 ms |
| `GET /admin/media`, `/admin/navigation`, `/admin/pages` | 11 à 16 ms |
| `POST /api/cart`, `GET /admin/login`, le cron | 6 à 9 ms |

À chaud, sous la charge (`cpu-chaud.txt`) :

| Route | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `GET /` | 6 ms | 11 ms | 32 ms | 45 ms |
| `GET /products/:slug` | 6 ms | 10 ms | 27 ms | 45 ms |
| `GET /categories/:slug` | 5 ms | 8 ms | 11 ms | 28 ms |
| `GET /search` | 6 ms | 9 ms | 20 ms | 38 ms |
| `GET /cart` | 5 ms | 9 ms | 29 ms | 34 ms |
| `POST /api/cart` | 4 ms | 6 ms | 12 ms | 20 ms |
| `GET /api/products` | 3 ms | 5 ms | 7 ms | 8 ms |

Le monitor relève un CPU p99 de 26 ms sur les trois heures, sans le juger : le
p99 d'une petite boutique, ce sont ses démarrages à froid. Le signal qu'il
juge, les invocations arrêtées par Cloudflare (erreur 1102), est à zéro.

### Les trois issues

1. **Rester au plan gratuit**, avec une dérogation écrite. La vitrine tient ses
   10 ms à chaud ; les dépassements sont ceux d'un démarrage à froid ou d'un
   rare pic, bornés à 53 ms, et Cloudflare tolère un dépassement occasionnel
   par isolat. Mesure compensatoire : le monitor nocturne, qui échoue dès
   qu'une invocation est arrêtée. Risque : une boutique dont le trafic rend
   les dépassements réguliers, ce que la charge de vingt acheteurs n'a pas
   produit.
2. **Passer le compte au plan Workers Paid** : 30 s de CPU par requête et plus
   de quota quotidien, 5 $ par mois et par compte. Sur le compte du marchand
   (ADR 0002), un abonnement par boutique ; la piste d'un compte de l'agence
   mutualisé est notée au plan d'implémentation, §13.1.
3. **Activer le cache de Workers en production**, que la configuration
   désactive aujourd'hui sur toutes les boutiques : les pages publiques ne
   réveilleraient plus le Worker, ce qui supprime aussi la plupart des
   démarrages à froid. Demande une purge après chaque déploiement
   (`CACHE_PURGE_SECRET`) et un passage dédié sur ce qui peut être caché.

Le quota de requêtes est l'autre chiffre à surveiller. Le monitor relève
58 456 requêtes Workers sur 100 000 pour la journée du compte A : un compte de
toute la journée et de tout le compte, bien au-delà des 7 307 de cette
boutique sur la fenêtre. Il est à rapprocher des autres Workers du compte
avant que la production n'en partage un.

## Défauts trouvés

| Défaut | Trouvé | Effet | État |
|---|---|---|---|
| la prose figeait des neutres : citation en `#6b7280`, code et blocs de code sur `#f5f5f4` | en réel | une page légale publiée avec son bandeau « Brouillon » (migration 0040) sous AA sur les quatre thèmes livrés, et un code illisible sous le texte clair de studio | la prose prend `--color-muted` et `--color-surface` ; le jeu d'essai porte le bandeau, et la porte locale le voit sur chaque thème, `v0.3.9` (#92) |
| Lighthouse recopie `--extra-headers` dans chaque rapport, JSON et HTML | en réel | la fiche, suivie telle quelle, publiait le secret du jeton de service dans le dépôt public de la boutique | masqué avant tout commit ; la fiche masque les rapports, et `check:secrets` refuse celui qui porte encore le secret, `v0.3.9` (#92) |
| sous WSL, Lighthouse crée ses profils Chrome dans le dossier courant | en réel | quatre profils, cookies d'Access compris, à la racine de la boutique, non suivis par git | supprimés ; la fiche lance Lighthouse depuis un dossier jetable (#93) |
| `wrangler tail` perd des événements sans le dire | en réel | 37 sur 46 requêtes à froid, 2 767 sur environ 6 530 sous la charge, sans échantillonnage annoncé et sans cache devant le Worker ; trois routes manquent au relevé à froid | dit dans la fiche, qui renvoie à Observability pour ce qui manque |
| le jeton API du monitor, créé sans « Account Settings : Read » | en réel | `shopctl monitor` s'arrête à `wrangler whoami`, qui ne voit aucun compte | droit ajouté au jeton ; le jeton de lecture de la production, documenté avec « Account Analytics » et « D1 » seuls, aura le même manque : à vérifier à l'étape 9 |
| un clone neuf de la boutique n'a pas de remote `core` | en réel | `core upgrade` refuse de monter | la section 0 de la fiche l'ajoute (#92) |
| le `trap` de `test/integration/d1-integration.sh` tue `npx`, pas le `wrangler dev` qu'il lance | en réel | chaque `npm run verify` laisse un `wrangler dev` et son `workerd` en vie sur le poste | arrêtés à la main ; non corrigé |

## Ce que la mesure ne dit pas

- **Les photos du catalogue témoin sont petites.** Un LCP de 1,0 à 1,6 s
  mesuré sur elles dit peu de ce que donneront les vraies photos d'un
  marchand.
- **La charge vient d'une seule adresse.** La recherche est cadencée à la
  moitié de son limiteur pour ne pas le déclencher : la charge mesure la
  boutique, pas ce que les limiteurs laissent passer, que l'étape 5 a éprouvé.
- **Les percentiles à chaud portent sur un échantillon**, celui que
  `wrangler tail` a transmis : 42 % des requêtes.
- **Trois routes n'ont pas leur coût à froid** : la recherche, Produits et
  Commandes de l'administration, perdues par la capture et non relevées dans
  Observability à ce passage.

## Ce qui reste

1. Les trois achats manquants, chacun avec son navigateur, sa version et son
   numéro de commande, et une capture de la confirmation sur les téléphones.
   La ligne se coche alors.
2. La décision sur le CPU, entre les trois issues ci-dessus, avec sa
   dérogation écrite si c'est la première.
