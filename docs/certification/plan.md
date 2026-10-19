# Plan de certification du pilote (jalon 10)

Ce document dit **comment** la campagne du plan §8 se déroule en conditions
réelles : ce qu'il faut éprouver, sur quels comptes, avec quels secrets, dans
quel ordre, et qui fait quoi. Les critères eux-mêmes restent ceux du
[plan d'implémentation](../implementation-plan.md) (§8, §9, jalon 10) ; ce
document ne les redéfinit pas, il les ordonne.

Il est écrit pour être rejoué : la même campagne certifie le pilote, puis
chaque nouvelle boutique (plan §1, « une campagne de certification réutilisable
pour chaque nouvelle boutique »).

## 1. Point de départ

Au socle `v0.2.0`, les jalons 1 à 9 sont livrés, et tout ce qu'une doublure
peut prouver est prouvé à chaque commit : `npm run verify`, la porte de
sécurité, la porte navigateur, l'isolation de deux boutiques dans un compte
imaginaire. Un seul passage a eu lieu sur un compte réel : le déploiement
`minshop-test` du jalon 0, le 2026-08-29, par les scripts de l'époque et non
par `shopctl`.

Ce qui n'a **jamais** tourné en réel, et que chaque jalon a nommé plutôt que
coché :

| Jalon | Ligne ouverte | Ce qui la ferme |
|---|---|---|
| 0 | fiabilité de l'intégration D1 en CI | l'observation du workflow `D1 flake probe`, hors campagne |
| 3 | test « remises » contre un vrai code promotionnel | un checkout Stripe test avec un code réel (étape 4) |
| 6 | provisioning dans un compte de test | `shopctl provision` sur le compte agence (étape 3) |
| 6 | smoke test avant promotion | dérogation proposée : demande les déploiements graduels (§6) |
| 7 | Stripe test **et** live | étapes 4 et 10 |
| 7 | notification d'expédition | une expédition réelle en staging (étape 4) |
| 7 | critère de sortie : paiement réel encaissé puis remboursé | étape 10 |
| 8 | supervision, runbooks d'incident | étapes 0 et 8 |
| 8 | critère de sortie : restauration chronométrée < 1 h | étape 8 |
| 9 | rollback applicatif | étape 8 |
| §7.3 | tout le nocturne | étape 0 (workflow) puis étape 8 (premier passage) |
| §7.4 | sauvegarde verte avant production | étape 0 (enchaînement) puis étape 9 |
| §8.3 | les lignes sur des boutiques **déployées** | étape 7 |

## 2. Dispositif

### 2.1 Les boutiques

- **`pilote-certif`**, la boutique certifiée : un vrai dépôt, un vrai
  manifeste, de vrais domaines, sur le modèle du témoin `pilot-fr` dont elle
  reprend le thème (`--from-theme atelier`). Le catalogue témoin de vingt
  produits est importé tel quel.
- **`canari-certif`**, la contre-épreuve, sur le modèle de `canary-minimal`
  (`--from-theme market`). Elle ne sert qu'à l'étape 7 : déployée en staging à
  côté de `pilote-certif`, dans le même compte, pour rejouer les lignes du §8.3
  que la porte d'isolation ne peut pas tenir.

Elles ne peuvent pas porter le nom des témoins. Le socle garde
`test/fixtures/clients/` dans chaque boutique, chaque témoin y réclame son slug
et tous les noms qui en dérivent, et la porte du manifeste refuse deux boutiques
pour un nom : une boutique `pilot-fr` échouerait à sa propre CI aussi longtemps
qu'elle vivrait. Constaté le 2026-10-11 en répétant l'étape 2 ; `shopctl new`
refuse désormais un tel slug avant de cloner.

### 2.2 Les comptes

Le cycle de vie de l'[ADR 0015](../architecture/decisions/0015-cycle-de-vie-d-une-boutique.md)
fait passer une boutique d'un compte à l'autre entre la preview et la saisie.
La campagne l'éprouve tel quel, donc il faut **deux** comptes Cloudflare :

| Compte | Rôle | Environnements |
|---|---|---|
| Cloudflare **A** — agence | construction et preview privée | `pilote-certif` staging, `canari-certif` staging |
| Cloudflare **B** — « client » | saisie et mise en ligne | `pilote-certif` production, cible de la restauration |
| Stripe — mode test | tout le fonctionnel | staging |
| Stripe — mode live | la commande réelle et son remboursement | production |
| Resend | e-mails de commande et d'expédition | staging puis production |
| GitHub | dépôts des deux boutiques, environnements, approbation | — |

Le compte B joue le client. Pour le pilote, c'est un second compte au nom de
Damien ; pour une vraie boutique, c'est celui du marchand
([ADR 0002](../architecture/decisions/0002-propriete-des-comptes.md)). Deux
comptes coûtent un formulaire et prouvent deux choses qu'un seul ne prouve
pas : que `provision` refuse le mauvais compte en vrai, et que la restauration
fonctionne **vers un autre compte**, ce qui est la condition de sortie d'un
client (ADR 0005).

### 2.3 Les secrets et identifiants

Aucun de ces éléments ne transite par le dépôt, par une conversation ou par un
argument de commande. La colonne « où » dit où chacun est posé.

| Élément | Nature | Qui le crée | Où il vit |
|---|---|---|---|
| ID du compte A, ID du compte B | identifiant, pas un secret | Damien | `client.yaml` (`cloudflare.accountId` pour A, `cloudflare.productionAccountId` pour B), et secret d'environnement GitHub `CLOUDFLARE_ACCOUNT_ID`, celui de chaque environnement, posé par `shopctl repo` |
| Jeton API Cloudflare, un par dépôt et par environnement | secret | Damien, sur chaque compte | secret d'environnement GitHub `CLOUDFLARE_API_TOKEN`, posé par `shopctl repo` |
| Session Wrangler de l'opérateur | secret | Damien (`wrangler login`) | la machine qui exécute `shopctl` |
| `AUTH_SECRET`, `SECRETS_KEK` | secrets internes | `shopctl provision` | secrets du Worker, tirés par boutique et par environnement, jamais affichés |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | configuration, pas un secret | Damien (application Access) | `client.yaml` (`cloudflare.stagingAccessTeam`, `cloudflare.stagingAccessAud`), rendus dans les `vars` du seul Worker de staging |
| Clé Turnstile (site + secret) | secret pour la seconde | Damien | Admin → Réglages → Protection anti-robots |
| `stripe_secret_key` test puis live (clé restreinte de préférence) | secret | Damien | coffre chiffré, Admin → Réglages → Paiements |
| `stripe_webhook_secret` test puis live | secret | Stripe, à la création de l'endpoint | coffre chiffré |
| `resend_api_key` | secret | Damien | coffre chiffré |
| Clé de sauvegarde | secret | `shopctl backup keygen` | `.shopctl/backup.key` (0600) chez l'opérateur, et secret d'environnement GitHub `SHOPCTL_BACKUP_KEY` posé par `shopctl repo` (conservé s'il existe déjà) |
| Mot de passe admin | secret | l'assistant `/admin/setup` | haché en D1 ; celui de staging aussi en secret d'environnement GitHub `MINSHOP_ADMIN_PASSWORD`, pour l'e-mail de test du nocturne |
| Jeton de service Access de staging | secret | Damien (Zero Trust → Service Auth) | secrets d'environnement GitHub `CF_ACCESS_CLIENT_ID` et `CF_ACCESS_CLIENT_SECRET`, pour le nocturne et les portes distantes |
| Clé Stripe test du nocturne | secret | Damien, clé restreinte « Checkout Sessions : écriture » | secret d'environnement GitHub `STRIPE_TEST_SECRET_KEY` ; une clé live est refusée |
| Destinataire de l'e-mail de test, origine de staging | configuration | Damien | secret d'environnement GitHub `NIGHTLY_EMAIL_TO` (une variable s'afficherait en clair dans les journaux, publics sur un dépôt public) et, sans `stagingDomain`, variable `STAGING_URL` |
| Jeton de lecture de l'analytique de production | secret, lecture seule (« Account Analytics : Read », « D1 : Read ») | Damien, sur le compte de la production | secrets du dépôt `MONITOR_CLOUDFLARE_API_TOKEN` et `MONITOR_CLOUDFLARE_ACCOUNT_ID` — hors de l'environnement `production`, dont les relecteurs bloqueraient chaque nuit |

L'endpoint de webhook Stripe pointe sur `https://<hôte>/api/webhook` et
s'abonne à cinq événements, ceux que l'adaptateur lit :
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired` et
`charge.refunded`. Derrière la preview privée, ce chemin est le seul qui
contourne Access ([guide, §5](comptes-et-acces.md#5-zero-trust-et-access-compte-a)) :
la signature que le Worker vérifie est ce qui le protège.

### 2.4 Où tournent les commandes

`shopctl provision`, `deploy`, `backup` et `restore` demandent une session
Wrangler sur le bon compte. Deux possibilités :

- **la machine de Damien**, avec `wrangler login` — recommandé : les
  identifiants ne quittent pas son poste, et la campagne exerce le chemin
  qu'un opérateur suivra ;
- **le workflow `Deploy` du dépôt de la boutique**, avec les jetons posés par
  `shopctl repo` — pour `deploy` seulement, et c'est ce que l'étape 9 exige de
  toute façon pour la production.

## 3. Règles de la campagne

- **Rien ne touche un compte réel sans le feu vert de Damien**, donné étape
  par étape. Chaque étape ci-dessous commence par la liste de ce qu'elle crée,
  modifie ou détruit, pour que ce feu vert porte sur quelque chose de précis.
- **Chaque ligne cochée porte sa preuve** : un rapport JSON de `shopctl`, une
  capture, un identifiant Stripe, une sortie de commande. Les preuves vont
  dans `client/certification/` du dépôt de la boutique, jamais une valeur
  secrète ni une donnée personnelle réelle. `client/` plutôt que `docs/` :
  `docs/` appartient au socle, et chaque preuve y serait une modification du
  socle à étiqueter `core-change`.
- **Une ligne qui échoue n'est pas cochée « avec réserve »** : elle est
  corrigée dans le socle, ou elle reçoit une dérogation écrite, datée, avec sa
  mesure compensatoire (critère de sortie du jalon 10).
- **Un défaut trouvé en réel devient un test** du socle quand une doublure
  peut le reproduire, comme les défauts du jalon 0 et du jalon 6 l'ont été.

## 4. Étapes

Les étapes sont ordonnées pour que chacune repose sur ce que la précédente a
prouvé, et pour que l'argent réel arrive en dernier.

### Étape 0 — Combler ce que le dépôt peut encore fermer

Aucun compte réel. Tout se fait par pull request sur le socle, et un tag
sort à la fin : la campagne certifie une version publiée, pas `main`.

- [x] faire viser une URL déployée par la porte navigateur (`BASE_URL` fourni
  de l'extérieur au lieu du serveur local) et par une variante distante des
  contrôles de sécurité qui ne demandent pas Miniflare (en-têtes, admin
  anonyme, CSRF, téléchargement non autorisé, traversée de chemin) — §8.4,
  §8.5. `npm run test:browser:remote` trouve dans le catalogue du marchand les
  pages que les specs demandent (produit simple, épuisé, stock faible…) et
  saute ce qu'il n'a pas en le disant ; `npm run test:security:remote` dérive
  les routes d'administration des fichiers, comme la porte locale. Derrière une
  preview privée, le jeton de service Access ne part que vers l'origine de la
  boutique. `npm run verify` fait tourner la porte distante contre le Worker
  construit (`test/integration/remote-gates.mjs`) : rouge sur une boutique
  en amorçage, verte en mode mot de passe et en mode Access ;
- [x] écrire le scénario de charge (vingt utilisateurs virtuels, quinze
  minutes) et celui des cinq checkouts concurrents sur la dernière unité —
  §8.6. `npm run test:load:remote` cadence la recherche à la moitié de son
  limiteur, compte les 429 à part et échoue sur une seule 5xx ;
  `npm run test:last-unit:remote -- --product <slug>` vérifie d'abord que le
  stock vaut 1, sans rien réserver, puis tire les cinq requêtes ensemble. Les
  deux tournent aussi dans `npm run verify` contre le Worker construit ;
- [x] enchaîner `shopctl backup` devant `deploy --env production` et bloquer
  le déploiement si elle échoue — §7.4, §9. L'archive est copiée dans un
  bucket R2 privé par environnement, `<worker>-backups`, sur le compte de la
  boutique et dans sa juridiction (décision du 2026-10-06, ADR 0005) ;
- [x] écrire le workflow nocturne du §7.3 sur la base de staging : checkout
  Stripe test, webhook, e-mail de test, sauvegarde, restauration vers un
  environnement éphémère, smoke tests, audit des dépendances.
  `.github/workflows/nightly.yml` : partout, la suite complète sur une D1
  neuve et `npm audit` (dépendances d'exécution gatées au niveau `high`) ;
  dans un dépôt de boutique, sur staging, `backup --upload`, la restauration
  de cette archive par `restore --local` dans la D1 du runner (jetée avec
  lui), les portes distantes, `shopctl monitor`, une session Stripe test
  expirée par l'API de Stripe dont le webhook doit rendre l'unité, et
  l'e-mail de test de l'administration. La jambe payée de Stripe reste
  manuelle (étape 4) : la page hébergée refuse d'être pilotée par un script ;
- [x] rédiger les runbooks d'incident (Worker en erreur, Stripe ne livre plus
  les webhooks, e-mails bloqués, base corrompue, fuite de secret, violation
  de données) et la procédure de sortie d'un client — jalon 8, §12. Dans
  `docs/operations/`, avec celui du mot de passe admin perdu ;
- [x] décider de la supervision : notifications Cloudflare (erreurs Worker,
  CPU, quotas D1) et alerte de passage au plan Workers Paid — jalon 8, §8.6.
  Le catalogue de Cloudflare n'a pas ces alertes aux plans d'une boutique ;
  `shopctl monitor` les lit dans l'API GraphQL Analytics et échoue au-delà de
  1 % d'erreurs ou de 70 % d'un quota du plan gratuit
  (`docs/operations/README.md`) ;
- [x] trancher les deux cases sans porte : le formateur (§7.1) et la CSP
  (§8.4, voir jalon 8) — adopter, ou dérogation écrite. Formateur : un
  plancher, `npm run check:format`, plutôt qu'un reformatage qui arriverait en
  conflit dans chaque boutique (§7.1). CSP : la part qu'aucun gabarit ne peut
  casser est posée et gatée, le reste est une dérogation datée (§6).
- [x] publier `v0.3.0` : la version et sa note (`docs/migrations/v0.3.0.md`)
  sont posées ; le tag est sorti du workflow `Release` le 2026-10-06, sur
  `4c12bd8`, après la fusion de la pull request #39 ;
- [x] publier `v0.3.1`, la version dont part la campagne : deux trous trouvés
  en préparant l'étape 1 (`docs/migrations/v0.3.1.md`). Le Worker de staging
  ne recevait pas les valeurs de l'application Access, et `/admin/setup`
  aurait répondu 403 derrière elle ; le manifeste ne nommait qu'un compte pour
  les deux environnements, alors que staging vit sur A et la production sur B.
  Le tag est sorti du workflow `Release` le 2026-10-06, sur `91a7994`, après la
  fusion de la pull request #42.

Fait avancer : jalon 8 (supervision, runbooks), jalon 10 (outillage de la
campagne).

### Étape 1 — Comptes et accès

Actions humaines uniquement (ADR 0002) ; `shopctl doctor` vérifie ce qu'il
peut et nomme le reste. Le pas-à-pas — ordre, droits de chaque jeton, valeurs
à relever et moment où naît chaque secret — est dans
[`comptes-et-acces.md`](comptes-et-acces.md).

Les comptes sont cochés sur la déclaration de Damien du 2026-10-08 ; les
étapes 2 et 3 les relisent par leurs propres commandes.

- [x] compte Cloudflare A et compte B, R2 activé sur les deux ;
- [x] un domaine réel dans une zone du compte A pour la preview
  (`stagingDomain`), et un domaine pour la production rattaché au compte B ;
- [x] Zero Trust activé sur A, une application Access sur le nom d'hôte de
  preview, son `AUD` relevé ;
- [x] un widget Turnstile ;
- [x] Stripe : compte en mode test ; activation du mode live (vérification
  d'identité) lancée tôt, parce qu'elle prend des jours ;
- [x] Resend : domaine d'envoi vérifié (SPF, DKIM), une clé API ;
- [x] GitHub : décidé le 2026-10-08, le compte reste en Free et les dépôts de
  boutique du pilote sont **publics**. Sur un dépôt privé, Free n'a pas de
  secrets d'environnement (`Deploy` et `Nightly` les lisent là) et ne donne
  que 2 000 minutes d'Actions par mois ; sur un dépôt public, il a les secrets
  d'environnement, les relecteurs obligatoires et des minutes sans limite. En
  contrepartie, une boutique est un clone du socle avec son historique : le
  socle jusqu'au tag cloné, les adresses e-mail des auteurs de commits, le
  manifeste, les journaux et les rapports de la CI deviennent publics. Avant
  tout dépôt public, l'historique de `v0.3.1` a été passé blob par blob aux
  règles de `scripts/check-secrets.mjs` : rien. Une vraie boutique reste
  privée et demande alors GitHub Pro au minimum (§6) ;
- [ ] jetons API Cloudflare, un par dépôt et par environnement, avec les droits
  du guide — créés au moment où `shopctl repo` les pose (staging à l'étape 2,
  production à l'étape 9) plutôt que conservés d'ici là. Ceux de staging sont
  posés (2026-10-11) ;
- [x] `shopctl doctor` vert sur la machine de l'opérateur.

Fait avancer : jalon 6 (prérequis humains), jalon 10.

### Étape 2 — Forge réelle

Crée : deux dépôts GitHub publics (étape 1), `<login>/shop-pilote-certif` et
`<login>/shop-canari-certif`, leurs environnements, les secrets de `staging`, et
un jeton API sur A par boutique. Aucune commande ne touche un compte
Cloudflare : le jeton ne sert qu'à partir de l'étape 3. L'environnement
`production` n'a encore ni jeton ni compte ni clé : `shopctl repo` les pose
quand il est relancé avec le jeton de production, à l'étape 9.

Répétée le 2026-10-11 contre la doublure de `gh`, jusqu'au second
`shopctl repo` : c'est ce passage qui a trouvé les noms des témoins (§2.1).

Passée en réel le 2026-10-11 : `DamienGR/shop-pilote-certif` et
`DamienGR/shop-canari-certif`, preuves dans `client/certification/etape-2/` de
chacun. Le premier `shopctl repo` a créé le dépôt puis échoué au push :
`gh auth login` range `git_protocol` sous l'hôte, `shopctl` lisait la clé
globale (`https`) et posait un remote HTTPS sur un poste qui n'a que SSH.
Contourné en remettant `origin` en SSH, la commande étant rejouable ; corrigé
dans le socle après `v0.3.1`, avec son test.

- [x] `shopctl new pilote-certif --core v0.3.1 --account <A> --domain <domaine
  de production> --name <nom> --from-theme atelier --dir ../shop-pilote-certif`,
  sans `--create-repo` : cette option crée un dépôt privé, et `shopctl repo` ne
  change jamais la visibilité d'un dépôt qui existe. `--dir`, parce que
  `npm run` exécute dans le dépôt du socle et que la boutique s'y créerait ;
- [x] manifeste rempli de valeurs réelles, `npm run shopctl -- config validate`
  vert : dont `stagingDomain`, `stagingAccessTeam` et `stagingAccessAud`
  relevés à l'étape 1, et `productionAccountId` pour le compte B. **Commité** :
  `shopctl repo` pousse la branche, pas l'arbre de travail ;
- [x] `npm run shopctl -- doctor` vert dans l'arbre de la boutique (étape 1) ;
- [x] `shopctl backup keygen` dans l'arbre de la boutique : sans cette clé,
  `shopctl repo` ne pose pas `SHOPCTL_BACKUP_KEY`, et la sauvegarde du
  nocturne de l'étape 3 échoue ;
- [x] `shopctl repo --public --reviewer <login>` dans l'arbre de la
  boutique, avec le jeton de staging dans `CLOUDFLARE_API_TOKEN_STAGING` et
  **sans** `CLOUDFLARE_API_TOKEN` dans le shell, que `shopctl repo` poserait
  aussi dans `production` : dépôt public créé, branche poussée, `staging` et
  `production` créés, un relecteur obligatoire sur `production`, secrets de
  `staging` posés ;
- [x] la même commande relancée, `--reviewer` compris : rien ne change, les
  secrets sont réécrits, la clé de sauvegarde est conservée ;
- [x] workflow `Nightly` désactivé dans le dépôt de la boutique jusqu'à
  l'étape 3 : sans base de staging, son job de staging échouerait chaque nuit ;
- [x] une pull request de la boutique fait tourner sa CI — §7.2 : celle qui
  verse les rapports `--json` de cette étape dans `client/certification/`.
  Rouge au premier passage, pour deux défauts du socle qu'aucune doublure ne
  voyait (remote `core` absent d'un checkout de CI, pas de signature de design
  pour le thème de la boutique) : corrigés en `v0.3.2`, que chaque boutique
  prend par `shopctl core upgrade --to v0.3.2 --open-pr` avant cette ligne.
  Ces montées (pull requests #5) ont trouvé le troisième : la porte de
  propriété bloquait les fichiers apportés par la release, levée par le label
  `core-change`, corrigée après `v0.3.2`. Verte le 2026-10-12 sur les deux
  pull requests #4, vingt jobs sur vingt ;
- [x] idem pour `canari-certif` (`--from-theme market`, domaine laissé au
  placeholder : elle n'a pas de production), sans `accountId` déclaré :
  `CLOUDFLARE_ACCOUNT_ID` absent du shell au `shopctl new`, qui l'écrirait dans
  le manifeste, et exporté pour le seul `shopctl repo`, qui en a besoin pour
  les deux environnements.

Fait avancer : jalon 6 (forge), §7.2.

### Étape 3 — Staging sur le compte agence

Crée, pour `pilote-certif` seule (`canari-certif` attend l'étape 7), sur A :
le Worker et son domaine personnalisé sur le nom d'hôte de preview, la base D1
et trois buckets R2 en juridiction `eu` (images, fichiers, sauvegardes avec sa
règle de conservation de 90 jours), le namespace KV des sessions que wrangler
crée au premier déploiement, les secrets internes, le catalogue témoin ; dans
Access, une application de contournement sur le seul chemin du webhook ; dans
Stripe test, l'endpoint du webhook.

Répétée le 2026-10-12 en doublure, contre une boutique `v0.3.2` et un
`wrangler` de doublure qui choisit désormais son compte comme la version
4.149 : quatre trous du socle, trouvés avant tout passage en réel, corrigés
après `v0.3.2` et livrés avec `v0.3.3`. Tant que la boutique porte `v0.3.2`,
la [fiche de commandes](etape-3-commandes.md) les contourne.

Passée en réel à partir du 2026-10-13, elle en a trouvé deux autres. Le
staging de `v0.3.2` répondait 500 à chaque enregistrement de
l'administration, `/admin/setup` compris, données pourtant écrites : un
Worker sans cache reçoit un `cache` sans `purge`, que le socle prenait pour
une purge échouée (journaux de `wrangler tail`). Et `shopctl doctor`
déclarait active une session wrangler qui n'existait pas : la case de
l'étape 1 reposait sur un faux vert. L'étape 4 passant par l'administration,
`v0.3.3` est publiée pendant l'étape 3 avec les six correctifs
(`docs/migrations/v0.3.3.md`), et la montée de version réelle de l'étape 8
vise `v0.3.4`.

- `shopctl` vérifiait le compte mais ne le passait pas à wrangler. Avec une
  session qui voit A et B — celle du guide de l'étape 1 —, un wrangler dont
  l'entrée n'est pas un terminal refuse (« More than one account
  available »), ou prend le compte qu'il a mis en cache la dernière fois
  qu'on en a choisi un à la main dans l'arbre : `provision` aurait alors créé
  la boutique sur B en annonçant A. Contournement : `CLOUDFLARE_ACCOUNT_ID`
  exporté, égal au manifeste. `catalog import --remote` ne nommait aucun
  compte ; il passe désormais par la même résolution.
- `deploy` lisait l'origine à tester dans la sortie de wrangler. Celle-ci
  liste un domaine personnalisé sans `https://` et n'annonce aucune URL
  `workers.dev` une fois cette porte fermée : sur une preview privée comme en
  production (y compris par le workflow `Deploy`), le test de fumée n'avait
  rien à interroger, ou interrogeait le lien de documentation d'un
  avertissement. L'origine vient désormais du manifeste. Contournement :
  `--url https://<nom d'hôte de preview>`.
- `deploy --json` laissait la sortie de `npm run verify` et du build sur la
  sortie standard, devant le rapport : le workflow `Deploy` n'aurait pas pu
  lire l'origine dans un rapport qui n'est plus du JSON, et la preuve versée
  aurait été illisible. Elle passe désormais sur la sortie d'erreur.
  Contournement : `npm run verify` et `npm run build` lancés à part, puis
  `deploy --skip-verify --skip-build --json`.
- le contrôle d'e-mail du nocturne se connectait à l'administration avec le
  seul mot de passe : Turnstile activé, la connexion était refusée et le
  contrôle rouge chaque nuit. Il répond désormais au widget de test par le
  jeton factice que seules les clés de test acceptent, et devant un widget
  réel se saute en le disant. Contournement : clés de test enregistrées,
  case « Enable Turnstile » décochée jusqu'à `v0.3.3`.

`npm run verify` a aussi tourné dans l'arbre de la boutique avec la
configuration de staging rendue (domaine, `workers.dev` fermé, variables
d'Access) : vert. C'est ce que `deploy` exécute avant de téléverser.

- [x] `provision --env staging --dry-run`, puis réel, puis une seconde fois :
  le second passage ne crée rien ;
- [x] `provision` avec le mauvais compte : refus, code de sortie 4 ;
- [x] juridiction `eu` lue sur la base et les buckets via l'API ;
- [x] bucket de fichiers inaccessible publiquement ;
- [x] `deploy --env staging` : smoke test vert, **et** requête anonyme sur la
  preview refusée, **et** `workers.dev` fermé ;
- [x] `/admin/setup` derrière Access, mot de passe posé ;
- [x] le chemin du webhook, et lui seul, contourne Access : Stripe ne passe
  pas une page de connexion (guide de l'étape 1, §5). Un POST non signé y
  reçoit le 400 du Worker, pas la redirection d'Access ;
- [x] `catalog import --remote` du catalogue témoin, puis une seconde fois :
  plan vide ;
- [x] clés Stripe test et Resend saisies dans l'administration, et les clés de
  test de Turnstile (guide de l'étape 1, §6) : le contrôle d'e-mail du
  nocturne se connecte à l'administration, ce qu'aucun script ne fait devant
  un widget réel. Le premier `Nightly` du 2026-10-13 a trouvé une vraie clé
  de site et sauté l'e-mail ; clés de test posées, le second
  ([run 38466884657](https://github.com/DamienGR/shop-pilote-certif/actions/runs/38466884657))
  s'est connecté et l'a envoyé ;
- [ ] secrets et variables du nocturne posés dans l'environnement `staging`
  du dépôt (§2.3), puis le workflow `Nightly` réactivé et lancé à la main :
  vert, ou chaque contrôle sauté nommé dans son avertissement. Posés et lancé
  le 2026-10-13, relancé après les clés de test de Turnstile
  ([run 38466884657](https://github.com/DamienGR/shop-pilote-certif/actions/runs/38466884657)) :
  sauvegarde, restauration, porte de sécurité, Stripe et e-mail verts. Deux
  rouges laissent la ligne ouverte. La porte navigateur cherchait l'image
  principale d'une fiche sous la seule forme d'une galerie (défaut du test,
  corrigé par la pull request #59, à prendre par une montée de version). Le
  CPU p99 dépasse les 10 ms du plan gratuit — renvoyé à l'étape 6.

Preuves dans `client/certification/etape-3/` de `pilote-certif` (pull
request #7). Le premier `Nightly` a aussi montré que `NIGHTLY_EMAIL_TO`, posée
en variable, s'affiche en clair dans un journal public : c'est désormais un
secret (pull request #58). Le `Nightly` de `v0.3.3` ne lit que la variable :
elle passe en secret à la prochaine montée de version de la boutique.

Fait avancer : jalon 6 (« provisioning dans un compte de test »), jalon 4
(import réel), §8.4 en partie.

### Étape 4 — Fonctionnel et paiement en mode test

Crée : des commandes Stripe test, des e-mails réels vers des boîtes de test.

Répétée le 2026-10-13 en doublure, contre le Worker construit de
`pilote-certif` en `v0.3.3`, le catalogue témoin, et Stripe et Resend simulés :
quatre commandes, le webhook rejoué, deux remboursements, l'expédition, la
panne de Resend rattrapée par le cron, l'export. Trois défauts, corrigés après
`v0.3.3` et livrés avec `v0.3.4` : l'option de livraison gratuite s'appelait
« Free shipping » sur la page de Stripe et dans la commande ; la version texte
des e-mails de commande omettait la TVA ; et la documentation du socle disait
qu'une page publiée entre seule dans le pied de page, qui est un menu depuis la
migration 0028. Le catalogue témoin, vingt produits pour vingt-quatre par page,
ne montre jamais la pagination : la [fiche de commandes](etape-4-commandes.md)
ajoute cinq produits le temps de la voir.

Passée en réel le 2026-10-14, elle en a trouvé quatre autres, corrigés dans le
socle (pull request #64) et livrés avec `v0.3.4`.

- Les quatre pages légales n'avaient pas d'identifiant public : la migration
  0040 les insère après la 0033, et rien ne lance
  `scripts/backfill-public-ids.mjs`. L'administration les liait à
  `/admin/pages/null/edit`, et aucune ne pouvait être publiée. Toute boutique
  créée depuis la 0040 est touchée. Contournement : le script lancé avec
  `--remote` sur la base de staging, qui n'a rempli que ces quatre lignes.
- `/express` répète la case CGV dans le formulaire de chaque moyen de
  paiement : deux moyens, deux cases. Le panier n'en montre qu'une.
- Le paiement de démonstration est offert à côté de Stripe : `enabledMethods`
  l'ajoute tant que l'administration ne le désactive pas, et n'importe quel
  visiteur passe alors une commande sans payer, stock décrémenté. C'était le
  second moyen de `/express`. « Demo checkout » décoché dans les réglages de
  la boutique ne la fermait pas : `/checkout` ne vérifiait que la
  configuration du moyen, toujours vraie pour la démo, et un POST forgé y
  passait encore. Le staging en `v0.3.3` reste ouvert ainsi, derrière Access ;
  la production de l'étape 9 doit porter `v0.3.4`. Depuis, la démo n'est
  offerte qu'en l'absence de tout vrai moyen, et chaque entrée exige un moyen
  activé.
- Les transporteurs de l'expédition sont américains (USPS, UPS, FedEx, DHL,
  Other), quand les tarifs par défaut s'appellent Colissimo. Contournement :
  « Other », sans lien de suivi dans l'e-mail.

Les images des e-mails ne s'affichent pas sur le staging : la preview les sert
derrière Access, qui répond par sa page de connexion. Attendu ; c'est en
production, à l'étape 9, qu'elles se vérifient.

- [x] le parcours du §8.1 ligne par ligne, sur desktop et mobile ;
- [x] les sept lignes du §8.2, chacune avec l'identifiant Stripe, la ligne D1
  et le stock avant/après : quatre commandes, montants de Stripe égaux à ceux
  de D1, une commande par session, stock décrémenté une fois ;
- [x] un code promotionnel réel : remise sur la commande, TVA calculée après
  remise (ligne ouverte du jalon 3). `CERTIF10` sur B : 42,40 − 4,24 + 5,90 =
  44,06 €, dont TVA 7,34 € ;
- [x] remboursement partiel puis total depuis Stripe : la commande suit ;
- [x] webhook rejoué depuis le tableau de bord Stripe : aucune seconde
  commande. Le `charge.refunded` rejoué ne compte pas deux fois ;
- [x] expédition saisie dans l'administration : l'e-mail d'expédition part
  (ligne ouverte du jalon 7), avec le transporteur « Other » ;
- [x] Resend rendu indisponible (clé révoquée le temps du test) : la commande
  est écrite, l'e-mail part au balayage suivant — §8.7. Nouvelle clé collée
  trois minutes après la commande, les deux e-mails partis à la deuxième
  tentative ;
- [x] export des commandes, pages légales publiées, case CGV — §8.1. Pages
  publiées après le contournement de leur identifiant public.

Preuves dans `client/certification/etape-4/` de `pilote-certif` (pull
request #9).

Fait avancer : jalon 7 (Stripe test, notification d'expédition), jalon 3
(remises), §8.1, §8.2.

### Étape 5 — Sécurité sur la boutique déployée

Lecture seule, plus quelques requêtes hostiles vers sa propre boutique, et une
commande de test sous capture des journaux.

Répétée le 2026-10-14 en doublure, contre le Worker construit de
`pilote-certif` en `v0.3.3` derrière une doublure d'Access, Stripe et Resend
simulés : la porte distante, l'étape 4 rejouée sous capture, `npm audit`, le
scan de secrets sur l'arbre, l'historique public et le build de staging. La
boutique a tenu ; deux défauts, corrigés après `v0.3.3` et livrés avec
`v0.3.4`. Cloudflare nomme un compte « <adresse>'s Account », et `shopctl`
recopiait ce nom : l'adresse de connexion de l'opérateur est publiée dans cinq
preuves de l'étape 3 et dans les journaux et artefacts du `Nightly` ; elle est
masquée à la source, et la [fiche de commandes](etape-5-commandes.md) dit quoi
faire de ce qui est déjà publié. `npm audit` complet trouvait deux alertes
élevées dans `sharp`, outil de test seulement, que l'audit de production du
`Nightly` ne voyait pas ; `sharp` est forcé en 0.35.5. L'outillage de l'étape 0
ne couvrait pas quatre lignes, ajoutées : webhooks non signés et forgés, champs
de carte et limiteurs (`--limiteurs`) dans la porte distante, relevé d'une
capture de `wrangler tail` (`npm run test:logs:remote`), scan de tout
l'historique Git (`npm run check:secrets:history`). L'étape se passe donc en
`v0.3.4` : la fiche commence par la montée, ce qui coche d'avance la ligne de
montée réelle de l'étape 8.

Passée en réel les 2026-10-14 et 2026-10-15, en `v0.3.4`. La boutique a tenu,
sauf ses limiteurs ; cinq défauts, dont quatre corrigés dans le socle par la
même pull request que ce bilan.

- **Les limiteurs de débit sont actifs mais très permissifs.** Les liaisons
  sont sur la version déployée et le code passe par elles, sans erreur ; mais
  la porte n'obtient aucun 429 en trois fois la limite, 232 recherches une par
  une en 70 s passent toutes (limite : 60 par minute), et 1 000 recherches, 50
  en parallèle, donnent un premier 429 après environ 450. Cloudflare documente
  ce limiteur comme permissif, compté par localisation et mis en cache par
  machine ; les doublures, qui comptent exactement, ne pouvaient pas le voir.
  Il arrête une inondation de la recherche ou du checkout, pas un essai patient
  de mots de passe sur une administration sans Access, ce qu'est la
  production. Décidé : un compteur exact des échecs de connexion, et la porte
  recalibrée, en `v0.3.5`. Livrés, et rejoués contre le staging (ci-dessous).
- **`deploy` s'arrêtait dans le shell de la fiche.** Elle exporte
  `CLOUDFLARE_ACCOUNT_ID`, dont le test de `shopctl new` héritait par
  `npm run verify` ; et le test du scaffold suivait le `core.autocrlf=true` du
  poste. Les deux tests sont désormais indépendants de l'environnement de
  l'opérateur.
- **L'historique de chaque boutique en `v0.3.4` est rouge** sur un JWT
  d'exemple signé « sig », commité par le socle (`cfada29`) puis retiré de
  l'arbre. La règle exige désormais une signature de vraie longueur.
- **Chaque `HEAD` sur une image levait une exception** dans les journaux :
  Astro le confie au gestionnaire `GET`, qui le mettait en cache, ce que l'API
  Cache refuse. La réponse restait un 200.

La capture de `wrangler tail` a été échantillonnée (`overload`) pendant les
rafales de `--limiteurs`, et elle a été refaite, la porte passée sans eux. Les
en-têtes d'identité d'Access y arrivent déjà masqués par la plateforme.
`NIGHTLY_EMAIL_TO`, encore une variable, a été posé en secret avant le
`Nightly` d'après la montée, comme le demandent les notes de `v0.3.4`.

Le même jour, la ligne des limiteurs, d'après la
[fiche](etape-5-commandes.md#après-v035--fermer-la-ligne-des-limiteurs) :
`v0.3.5` montée (pull request #12 de la boutique) et déployée sans
contournement, `CLOUDFLARE_ACCOUNT_ID` exporté et `core.autocrlf=true` sur le
poste, migration 0044 appliquée ; la porte, `--limiteurs` compris, 18
contrôles sur 18. Juste après, l'opérateur est entré dans l'administration :
sa session du matin était encore valable, et son navigateur sort en IPv6, un
autre réseau, pour le compteur, que le terminal WSL en IPv4. Le compteur
refuse les nouvelles tentatives d'un réseau ; il ne ferme pas une session
ouverte.

- [x] les neuf lignes du §8.4 contre l'URL de staging
  (`BASE_URL=… npm run test:security:remote -- --limiteurs`). Elle échoue si
  l'admin de staging est en mode Access seul : un jeton de service est une
  identité Access valide, et il y entrerait — staging garde un mot de passe.
  En `v0.3.4`, 15 contrôles sur 15 et les trois limiteurs en échec ; en
  `v0.3.5`, 18 sur 18 : la recherche refuse dans ses 250 premières requêtes
  et le checkout dans ses 100 premières, 50 à la fois ; la connexion refuse la
  sixième tentative du passage, par le compteur exact (`Retry-After` au-delà
  de la minute de Cloudflare) ;
- [x] `wrangler tail` pendant une commande, un remboursement, une expédition
  et la porte distante : aucune adresse e-mail ni postale, aucun jeton ni
  secret dans ce que la boutique écrit ni dans les URL. 531 événements sans
  échantillonnage ; la trace du webhook de la commande, dans Observability, ne
  porte aucune donnée personnelle ;
- [x] `npm audit` racine et `mcp/`, outils de développement compris : aucune
  vulnérabilité élevée ou critique non justifiée. Aucune, toutes sévérités ;
- [x] scan de secrets sur l'arbre de la boutique, tout son historique et ses
  artefacts de build ; ni secret ni adresse dans les journaux et artefacts
  publics du `Nightly`. L'historique, vert avec la règle corrigée ; les
  journaux et artefacts des `Nightly` d'avant la montée supprimés, ceux
  d'après relus.

Preuves dans `client/certification/etape-5/` de `pilote-certif` (pull
requests #11, puis #13 pour la ligne des limiteurs).

Produit : le **rapport de sécurité**, [`rapport-securite.md`](rapport-securite.md) :
les neuf lignes du §8.4 tenues sur le staging, les limiteurs depuis `v0.3.5` ;
la porte se rejoue contre la production à l'étape 9.

Fait avancer : jalon 10 (§8.4, rapport de sécurité), jalon 8 (journaux et
portes de sécurité sur un déploiement réel).

### Étape 6 — Accessibilité, navigateurs, performance

- [ ] porte navigateur contre l'URL de staging — §8.5 (`BASE_URL=… npm run
  test:browser:remote`) ;
- [ ] parcours d'achat à la main sur Chrome et Firefox desktop, Safari sur
  iPhone, Chrome sur Android ;
- [ ] Lighthouse mobile sur l'accueil, une catégorie, une fiche produit, le
  panier : ≥ 90 en performance, accessibilité et SEO ; LCP, CLS, INP relevés ;
- [ ] charge de quinze minutes : aucune erreur Worker, consommation du plan
  Workers Free relevée (`npm run test:load:remote -- --json charge.json`,
  puis `shopctl monitor --env staging --hours 1`) ;
- [ ] cinq checkouts concurrents sur la dernière unité : une seule commande
  (`npm run test:last-unit:remote -- --product <slug>`, stock mis à 1 dans
  l'administration avant).

Le CPU, constaté à l'étape 3 : sur le staging, l'administration prend 13 à
43 ms de CPU par requête, la connexion 35 ms, `GET /` 26 ms à froid, le cron
1 à 4 ms ; le plan gratuit annonce 10 ms. Cloudflare tolère un dépassement
occasionnel par isolat et n'interrompt (erreur 1102, issue `exceededCpu`)
qu'un Worker qui le franchit régulièrement : aucune invocation interrompue à
ce jour. Mesurer à chaud (charge) et à froid (première visite après un temps
mort) séparément, page par page, vitrine d'abord ; optimiser autant que
possible avant de choisir entre le plan Workers Paid et une dérogation. Le
seuil de `shopctl monitor` juge aujourd'hui le p99 : le compte des
invocations `exceededCpu`, qu'il regroupe déjà par statut, est le signal qui
compte.

Répétée en doublure le 2026-10-15 ; ce qu'elle a trouvé est corrigé dans
`v0.3.6`, et la fiche de passage est [etape-6-commandes.md](etape-6-commandes.md).
Le monitor y juge les invocations arrêtées et relève le p99 sans le juger ; la
vitrine lit sa base en un appel par page (à chaud, la fiche produit passe de
13 à 16 ms à 8 ms sur le Worker construit) ; `npm run test:cpu:remote` relève
le CPU route par route d'une capture de `wrangler tail`, à froid après le
déploiement et à chaud sous la charge. Le cache de Workers, désactivé sur
toutes les boutiques, est la troisième issue à peser avec le plan payant et la
dérogation.
La charge déclenche les limiteurs de débit si elle vient d'une seule adresse :
le scénario doit les contourner explicitement ou les compter comme attendus,
pas les désactiver.

Produit : le **rapport de performance**.

### Étape 7 — Isolation de deux boutiques déployées

Crée : la boutique `canari-certif` en staging sur A.

- [ ] deux Workers répondant sur deux origines, deux bases, six buckets ;
- [ ] un produit créé dans l'une n'apparaît pas dans l'autre ;
- [ ] `catalog import` lancé depuis l'arbre de l'une vers l'autre : refus ;
- [ ] `shopctl destroy --env staging --confirm canari-certif` : tout part,
  et rien de `pilote-certif` ; si le bucket `-backups` porte des archives, R2 le
  refuse et la base reste — c'est le comportement attendu, à constater.

Fait avancer : §8.3 (lignes déployées), jalon 6 (`destroy` réel).

### Étape 8 — Exploitation et résilience

Crée : des archives de sauvegarde ; une restauration sur le compte B.

- [ ] `backup keygen`, `backup --env staging --upload`, puis `backup pull`
  depuis un autre poste et `backup verify` ;
- [ ] **restauration chronométrée** dans un environnement neuf du compte B :
  du premier `provision` à la boutique servie, < 60 minutes (RTO) ; la
  restauration se prouve elle-même table par table — critère du jalon 8 ;
- [ ] RPO ≤ 24 heures : le nocturne de l'étape 0 tourne trois nuits de suite ;
- [ ] `shopctl monitor --env staging` contre la vraie API Analytics : les
  champs que la doublure suppose existent, et un seuil abaissé à la main fait
  bien échouer le run ;
- [ ] média R2 supprimé à la main : la page dégrade sans erreur ;
- [ ] rollback Worker vers la version précédente, puis retour — jalon 9 ;
- [x] montée de version réelle : un tag `v0.3.4` proposé par
  `shopctl core upgrade --open-pr`, fusionné, déployé en staging. `v0.3.2` est
  déjà passée par ce chemin à l'étape 2, mais avant tout déploiement : la
  ligne demande une montée sur une boutique qui tourne. Faite en tête de
  l'étape 5, le 2026-10-14 : pull request #10 de `pilote-certif`, CI verte,
  fusionnée, déployée en staging avec la migration 0043. Les deux premiers
  `deploy` se sont arrêtés à leur `npm run verify`, sans rien téléverser
  (étape 5) ;
- [ ] rotation de `AUTH_SECRET` : les sessions tombent, rien d'autre ;
- [ ] mot de passe admin perdu : procédure exécutée telle que le runbook la
  décrit ;
- [ ] `privacy export` puis `anonymize` d'un acheteur de test.

Les runbooks de l'étape 0 sont corrigés d'après ce qui s'est réellement
passé. Produit : la **preuve de restauration**.

Fait avancer : jalon 8 (critère de sortie, supervision, runbooks), jalon 9
(rollback applicatif), §7.3, §8.7.

### Étape 9 — Bascule sur le compte « client »

Crée : la production de `pilote-certif` sur B. Détruit : le staging sur A.

- [ ] `provision --env production` sur B, que le manifeste nomme
  (`cloudflare.productionAccountId`) ;
- [ ] contenus saisis sur B, pas recopiés depuis A (ADR 0015) ;
- [ ] `deploy --env production` par le workflow `Deploy`, sauvegarde préalable
  verte, approbation GitHub ;
- [ ] domaine de production, domaine d'images, smoke test public vert ;
- [ ] la porte distante contre la production,
  `npm run test:security:remote -- --limiteurs` : sans Access devant
  l'administration, la connexion refuse au plus tard la sixième tentative
  ([rapport de sécurité](rapport-securite.md)) ;
- [ ] `shopctl destroy --env staging` sur A.

Fait avancer : jalon 6 (production), §7.4, §9.

### Étape 10 — Argent réel

Crée : une commande payée avec une vraie carte, puis son remboursement. Coût :
les frais Stripe de la transaction, que le remboursement ne rend pas.

- [ ] clés Stripe live et secret du webhook live dans le coffre de la
  production ;
- [ ] un produit à 1 € ; commande réelle ;
- [ ] cohérence relevée entre Stripe, D1, stock, administration et e-mail ;
- [ ] remboursement total ; la commande, le stock et l'e-mail suivent ;
- [ ] e-mails lus dans Gmail, Outlook et Apple Mail ;
- [ ] clés live retirées, ou boutique laissée fermée, selon la décision de
  l'étape 11.

Fait avancer : jalon 7 (critère de sortie), §8.8.

### Étape 11 — Validations humaines et décision

- [ ] relecture des pages légales et du consentement aux CGV ;
- [ ] validation TVA et facturation par un expert-comptable — le manifeste
  porte encore `invoiceStrategy: pending-validation` ;
- [ ] recette par une personne extérieure au développement, sur le modèle de
  procès-verbal du §12 ;
- [ ] documentation du §12 complète ;
- [ ] rapports assemblés, dérogations signées ;
- [ ] décision go/no-go (point de décision F, §11).

## 5. Livrables du jalon 10

| Livrable | Produit par |
|---|---|
| rapport de tests | étapes 3, 4, 6, 7 |
| [rapport de sécurité](rapport-securite.md) | étape 5 |
| rapport de performance | étape 6 |
| preuve de restauration | étape 8 |
| validation TVA/facturation | étape 11 |
| checklist de lancement | étape 9, rejouable pour chaque boutique |
| documentation de support | étapes 0 et 8 (runbooks), §12 |
| décision go/no-go | étape 11 |

## 6. Dérogations prévisibles

À écrire dès maintenant plutôt qu'à découvrir le jour de la décision :

- **smoke test avant promotion** (§5.5, étape 5) — demande les déploiements
  graduels de Cloudflare ; compensé par le smoke test public qui échoue et
  nomme la version de retour ;
- **approbation de production opposable** — sur un dépôt privé, les
  relecteurs obligatoires demandent GitHub Enterprise (Free, Pro et Team ne
  les offrent que sur un dépôt public) ; compensé par le fait que seul Damien
  a les droits d'écriture, et que `deploy --env production` exige `--yes`.
  Le pilote n'en a pas besoin : ses dépôts sont publics (étape 1), et
  `shopctl repo --reviewer` pose le relecteur que l'étape 9 attend ;
- **CSP, `script-src` et `style-src`** (écrite le 2026-10-06) — la boutique
  envoie `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` sur toute
  réponse, Worker et actifs statiques, et la porte de sécurité le vérifie.
  `script-src` et `style-src` restent ouverts : Astro sait hacher ses scripts
  et ses styles (`security.csp`), mais la boutique porte des scripts en ligne
  (`define:vars`, Turnstile) et des attributs `style` (préréglages de page) qu'il
  faut d'abord recenser un par un. Mesures compensatoires : corps de page en
  Markdown avec `html: false` (invariant 11), échappement d'Astro sur toute
  valeur rendue, `nosniff` partout, aucun fichier téléversé servi pour ce qu'il
  n'est pas (invariant 13). À rouvrir quand l'inventaire des scripts en ligne
  est fait — un passage à part entière, pas un en-tête de plus ;
- **critère 320 px de WCAG 1.4.10** — mesuré, non gaté (jalon 5).
