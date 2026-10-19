# Étape 6 — Accessibilité, navigateurs, performance

Passée le 2026-10-19 sur le staging de `pilote-certif` (compte A), monté de
`v0.3.5` en `v0.3.8`, puis en `v0.3.9` pour ce que l'étape a trouvé, selon la
fiche `docs/certification/etape-6-commandes.md` du socle. Stripe en mode test, avec un jeton de service Access « pilote-certif
étape 6 » créé pour l'étape, révoqué à la fin. Les visites à froid, l'admin
(menu d'en-tête, stock), l'INP et la dernière unité ont été passés par des
scripts Playwright hors du dépôt, à travers ce jeton, et la connexion admin par
le vrai formulaire.

## Les lignes de l'étape

| Ligne | Preuve | Résultat |
|---|---|---|
| porte navigateur contre le staging (§8.5) | `porte-navigateur.txt`, `porte-navigateur-v0.3.9.txt` | rouge en `v0.3.8` : 83 passés, 2 échecs, le contraste de la page de contenu (« Défauts » 1) ; **verte en `v0.3.9`** : 85 passés, 5 sautés avec leur raison (signature ×2, catalogue vide ×2, menu replié sur desktop). Le menu d'en-tête n'est plus vide, et son test clavier tourne sur téléphone |
| parcours d'achat sur quatre navigateurs | ci-dessous | **ouverte** : une commande payée sur quatre (#6) ; les trois autres achats restent à faire |
| Lighthouse mobile ≥ 90, LCP, CLS, INP relevés | `lighthouse-*.report.json`, `lighthouse-*.report.html` | 100 / 100 / 92 sur les quatre pages ; aucune requête hors de la boutique ; INP 24 ms (ci-dessous) |
| charge de quinze minutes, aucune erreur, consommation relevée | `charge.json`, `monitor.json` | 6 528 requêtes, 0 erreur, 0 réponse 429 ; le monitor vert sur les trois heures de l'étape, une fois son jeton corrigé (« Défauts » 4) : ci-dessous |
| CPU par page, à froid et à chaud | `cpu-froid.txt`, `cpu-chaud.txt` | aucune invocation arrêtée, à froid comme à chaud ; les chiffres ci-dessous |
| cinq checkouts sur la dernière unité | `derniere-unite.txt` | une session Stripe, quatre `409`, stock après : 0 ; aucune survente |

## La montée

`socle/v0.3.8` fusionnée par la pull request #15 (CI 20/20), avec les notes
de `v0.3.6`, `v0.3.7` et `v0.3.8`. Puis `deploy-v0.3.8.json` : `exit 0`,
`npm run verify` vert, migration 0045 appliquée, test de fumée arrêté par
Access (302), comme attendu derrière la preview. La capture à froid a démarré
avant toute visite.

`socle/v0.3.9` fusionnée par la pull request #17 (CI 20/20), puis
`deploy-v0.3.9.json` : `ok`, aucune migration, même test de fumée. `v0.3.9`
ne change que la CSS de la prose et l'outillage : les mesures de CPU, de
charge et de Lighthouse prises en `v0.3.8` valent pour elle ; seule la porte
navigateur a été rejouée.

## Lighthouse

| Page | Performance / Accessibilité / SEO | LCP | CLS | TBT |
|---|---|---|---|---|
| accueil | 100 / 100 / 92 | 1,6 s | 0 | 0 ms |
| catégorie (`/categories/maison`) | 100 / 100 / 92 | 1,5 s | 0 | 0 ms |
| fiche (`cabas-en-lin-lave`) | 100 / 100 / 92 | 1,4 s | 0 | 0 ms |
| panier garni | 100 / 100 / 92 | 1,0 s | 0 | 0 ms |

Le SEO perd sur un seul audit, `robots-txt` : Lighthouse lit `/robots.txt`
sans les en-têtes qu'on lui passe, reçoit la page de connexion d'Access et la
juge invalide. Celui de la boutique, lu avec le jeton, est valide (`Allow: /`,
`Disallow: /admin`, `Disallow: /api/`, le sitemap). Hors preview privée, le
SEO serait à 100.

Les rapports ont été **masqués avant d'entrer dans le dépôt** : Lighthouse y
recopie les en-têtes reçus, l'id et le secret du jeton de service, et le
cookie du panier. Les trois valeurs y sont remplacées par `<masqué>`
(« Défauts » 2).

**INP : 24 ms**, la pire de trois interactions (variante changée deux fois,
menu ouvert sur la fiche et sur le panier) ; l'ajout au panier, qui ouvre le
tiroir, est passé sous les 16 ms que l'Event Timing rapporte. Mesuré par
script plutôt que dans le panneau de DevTools : Pixel 7 émulé, CPU ralenti 4×
par CDP, l'Event Timing API relevée sur la page, la pire interaction retenue
(moins de cinquante interactions).

## Le CPU

À froid, la première requête de chaque route juste après le déploiement
(`cpu-froid.txt`) :

| Route | CPU à froid |
|---|---|
| `GET /` | 53 ms |
| `POST /admin/login` | 45 ms (le hachage du mot de passe, voulu) |
| `GET /categories/:slug` | 40 ms |
| `GET /products/:slug` | 35 ms |
| `GET /admin/settings` | 32 ms |
| `GET /admin` | 19 ms |
| `GET /cart` | 18 ms |
| `GET /admin/media` | 16 ms |
| `GET /admin/navigation` | 14 ms |
| `GET /admin/pages` | 11 ms |
| `POST /api/cart`, `GET /admin/login`, le cron | 6 à 9 ms |

Manquent au relevé, perdus par `wrangler tail` (« Défauts » 3) : la recherche,
Produits et Commandes de l'administration. Non relevés dans Observability à ce
passage ; la recherche est relevée à chaud.

À chaud, sous la charge (`cpu-chaud.txt`, 2 767 invocations relevées) :

| Route | p50 | p90 | p99 | max |
|---|---|---|---|---|
| `GET /` | 6 ms | 11 ms | 32 ms | 45 ms |
| `GET /products/:slug` | 6 ms | 10 ms | 27 ms | 45 ms |
| `GET /categories/:slug` | 5 ms | 8 ms | 11 ms | 28 ms |
| `GET /search` | 6 ms | 9 ms | 20 ms | 38 ms |
| `GET /cart` | 5 ms | 9 ms | 29 ms | 34 ms |
| `POST /api/cart` | 4 ms | 6 ms | 12 ms | 20 ms |
| `GET /api/products` | 3 ms | 5 ms | 7 ms | 8 ms |

Le monitor (`monitor.json`, `--hours 3`, de 17:00 à 20:00, la charge
comprise) : 0 erreur sur 7 307 requêtes ; 0 invocation arrêtée (erreur 1102) ;
CPU p99 26 ms, relevé, non jugé ; D1 à 16 % du quota quotidien en lecture et
1,2 % en écriture. Les requêtes Workers sont à 58 % du quota quotidien
(58 456 sur 100 000) : un compte de la journée et du compte A entier, bien
au-delà des 7 307 de cette boutique sur la fenêtre, donc à rapprocher des
autres Workers du compte avant la production.

La vitrine tient sous 10 ms en médiane et, à l'accueil près, au p90. Les
dépassements sont rares et bornés (45 ms au pire), et Cloudflare n'en a arrêté
aucun. Le choix entre plan gratuit avec dérogation, Workers Paid et cache de
Workers revient à Damien, sur ces chiffres.

## La dernière unité

Savon de Marseille 300 g (`prod_ce7f86f4fb`), stock passé de 40 à 1 dans
l'administration, puis cinq checkouts simultanés : une session ouverte sur
`checkout.stripe.com`, quatre `409`, stock après : 0. La session n'a pas été
payée ; à son expiration, l'unité est revenue (stock relu à 1 à 19:20, une
demi-heure après la course de 18:49), et le stock a été remis à 40 par le même
formulaire.

## Les parcours d'achat

Passés à la main par Damien le 2026-10-19, sans relevé des navigateurs ni des
versions sur le moment. L'administration ne montre qu'une commande payée ce
jour-là : **#6** (`ord_r0rgn4xrwc`, 65,70 €, 19:59). Rien de cassé signalé.

La ligne reste ouverte : trois achats de bout en bout manquent, à repasser en
notant pour chacun le navigateur, sa version, le numéro de commande et une
capture de la confirmation sur les téléphones.

| Navigateur | Version | Commande | Ce qui a accroché |
|---|---|---|---|
| _à relever_ | | #6 `ord_r0rgn4xrwc` | rien de signalé |
| _à faire_ | | | |
| _à faire_ | | | |
| _à faire_ | | | |

## Défauts

1. **Le contraste de la prose sous AA** sur la page de contenu, la page CGV :
   le bandeau « Brouillon » des pages légales (migration 0040) est une
   citation, et le socle figeait sa couleur à `#6b7280`, soit 4,37:1 sur le
   papier `#f7f3ec` du thème et 4,43:1 dans son `code`. Déjà vu par le
   `Nightly` de l'étape 5 et renvoyé ici ; la répétition ne pouvait pas le voir,
   ni la porte du socle, dont la page de contenu n'avait pas de citation. Les
   quatre thèmes livrés échouaient une fois la citation ajoutée au jeu
   d'essai. Corrigé dans `v0.3.9` : la prose prend ses couleurs du thème.
   Mesuré sur la page CGV du staging après le déploiement : 7,06:1 pour la
   citation, 6,41:1 pour son code.
2. **Lighthouse recopie `--extra-headers` dans ses rapports**, JSON et HTML :
   la fiche, suivie telle quelle, aurait publié le secret du jeton de service.
   Masqué ici avant tout commit. En `v0.3.9`, la fiche masque les rapports et
   `check:secrets` refuse celui qui porte encore le secret.
3. **`wrangler tail` perd des événements sans le dire** : 37 sur 46 requêtes
   à froid, 2 767 sur environ 6 530 sous la charge, sans échantillonnage
   annoncé et sans cache devant le Worker (`cache.enabled: false`, aucun
   `cf-cache-status`). Les percentiles à chaud portent donc sur un échantillon,
   et Observability, qui garde toutes les invocations, complète le froid.
4. **Le jeton API du monitor manquait « Account Settings : Read »** : `shopctl
   monitor` passe par `wrangler whoami`, qui ne voit aucun compte sans ce
   droit (`/accounts` vide). Le guide des comptes le prévoit pour le jeton de
   staging ; le jeton de lecture de la production, documenté avec « Account
   Analytics » et « D1 » seuls, aura le même manque : à vérifier à l'étape 9.
5. **Un clone neuf de la boutique n'a pas de remote `core`**, que `shopctl
   new` pose à la création et que `core upgrade` demande : ajouté à la main, et
   la section 0 de la fiche l'ajoute désormais.
6. **Sous WSL, Lighthouse a laissé ses profils Chrome dans la boutique** :
   quatre dossiers nommés `C:\Users\…\AppData\Local\lighthouse.XXXX` à la
   racine, chacun avec ses `Cookies` (celui d'Access compris), jamais suivis
   par git, trouvés parce que `core upgrade` refusait l'arbre. Supprimés à la
   main ; la fiche fait tourner Lighthouse depuis un dossier jetable (pull
   request #93 du socle).
7. **Chaque `npm run verify` laisse un `wrangler dev` en vie** : le `trap` de
   `test/integration/d1-integration.sh` tue `npx`, pas le `wrangler dev` qu'il
   a lancé. Vu après les deux `deploy` et le `verify` du socle ; arrêtés à la
   main. Non corrigé à cette étape.
