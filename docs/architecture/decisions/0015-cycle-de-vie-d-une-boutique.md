# ADR 0015 — Cycle de vie d'une boutique, de la construction à la livraison

- **Statut** : Accepté ; amendé le 2026-10-27 (la preview devient facultative) ;
  frontière entre les comptes remplacée par
  l'[ADR 0019](0019-compte-cloudflare-mutualise.md)
- **Date** : 2026-08-31
- **Jalon** : 6

## Contexte

L'ADR 0002 pose que le commerçant est propriétaire de tous ses comptes
fournisseurs, et que l'agence conserve son propre compte Cloudflare pour la
démonstration et les tests du socle. Il ne dit pas **quand**, dans la
construction d'une boutique, on passe de l'un à l'autre.

La séquence de travail réelle est : l'agence construit, le client regarde une
preview, le client saisit ses contenus et ses produits, puis on met en ligne.
La question est de savoir à quelle étape le compte du client devient
nécessaire, et la réponse a un coût mesurable, parce que **Cloudflare ne
transfère rien entre comptes** : ni une base D1, ni un bucket R2, ni un Worker.
« Déplacer » une boutique est en réalité un reprovisionnement, une migration de
données et une bascule DNS.

Deux faits vérifiés dans le code encadrent la décision.

Une **application Cloudflare Access se lie à un nom d'hôte**, et l'en-tête
`Cf-Access-Jwt-Assertion` qu'elle injecte est falsifiable contre une origine
`*.workers.dev` — `src/middleware.ts` le dit et vérifie la signature pour cette
raison. Une preview privée exige donc un nom d'hôte réel **et** `workers.dev`
fermé ; laisser les deux ouverts revient à ne rien fermer.

Et `isProtected()` ne couvre que `/admin` et `/api/admin` : la vitrine est
publique par construction. Fermer une preview est une affaire de bordure, pas
de code.

## Décision

Le cycle de vie d'une boutique a **quatre étapes**, et la frontière entre les
comptes tombe entre la deuxième et la troisième.

1. **Construction** — `staging` sur le compte Cloudflare de l'agence. Rien n'est
   encore au nom du client, et rien n'a besoin de l'être.
2. **Preview privée** — `staging` sert sur `cloudflare.stagingDomain`, un nom
   d'hôte d'une zone de l'agence, derrière une application Access. Déclarer ce
   champ **ferme `workers.dev`** sur cet environnement, parce que les deux
   ensemble ne ferment rien.
3. **Saisie par le client** — sur **le compte du client**. Le compte Cloudflare
   du client est le prérequis de cette étape, pas de la mise en ligne.
4. **Mise en ligne** — `production` sur le même compte client, puis
   `shopctl destroy --env staging` sur le compte de l'agence.

## Conséquences

- **il n'y a jamais de migration de données à écrire.** Le seul moment où des
  données existent est l'étape 3, et elle a déjà lieu sur le compte définitif.
  C'est la raison d'être de cette frontière : la placer à l'étape 4 rendrait
  `shopctl backup`/`restore` (jalon 9) obligatoire avant toute mise en ligne ;
- la dépendance au client se déclare plus tôt dans le planning, ce qui est une
  contrainte commerciale et non une contrainte technique : elle était de toute
  façon là, l'ADR 0002 en fait déjà « une dépendance de planning à afficher dès
  le devis » ;
- une preview qui n'a pas de `stagingDomain` sert sur `workers.dev` et **n'est
  pas privée**. Le rapport de déploiement le dit plutôt que de le laisser
  croire : le test de fumée d'un environnement déclaré privé pose la question
  inverse d'un environnement public, et une réponse 200 à une requête non
  authentifiée le fait échouer ;
- l'agence n'héberge jamais durablement les données d'un client, ce qui est la
  moitié opérationnelle de la promesse de réversibilité d'ADR 0002 ;
- `shopctl destroy` existe et est irréversible. Il demande le slug **saisi**, et
  `--yes` en plus en production.

### Note d'implémentation (jalon 10, 2026-10-06) — deux comptes à la fois, et l'application Access

Préparer l'étape 1 de la certification a montré deux choses que la décision
supposait sans que le socle les porte.

- **Entre l'étape 3 et la fin de l'étape 4, les deux comptes vivent en même
  temps** : le client saisit sur le sien, et le staging de l'agence reste sur
  celui de l'agence jusqu'au `destroy`. Quand la saisie a lieu en production —
  le dispositif de la certification (plan §2.2) —, un seul
  `cloudflare.accountId` faisait de chaque commande de production un désaccord
  entre le manifeste et le compte visé. `cloudflare.productionAccountId`, facultatif, nomme le compte de la
  production quand ce n'est pas `accountId` ; `environmentAccount()`
  (`scripts/manifest.mjs`) est la seule réponse à « sur quel compte vit cet
  environnement », et `shopctl repo` pose dans chaque environnement GitHub son
  propre `CLOUDFLARE_ACCOUNT_ID`. Ce n'est pas l'alternative écartée plus bas :
  le staging de l'agence disparaît toujours à la mise en ligne.
- **Derrière l'application Access, chaque requête porte une assertion**, et le
  Worker refuse celle qu'il ne peut pas vérifier : sans `CF_ACCESS_TEAM_DOMAIN`
  ni `CF_ACCESS_AUD`, `/admin/setup` répondait 403 tant qu'aucun mot de passe
  n'existait. Aucun outil ne les posait. `cloudflare.stagingAccessTeam` (le nom
  d'équipe ; le socle écrit l'adresse, pour qu'aucun manifeste ne pointe le
  vérificateur vers un autre serveur de clés) et `cloudflare.stagingAccessAud`
  sont rendus dans les `vars` du seul Worker de staging, vides partout
  ailleurs. Ils vont ensemble et demandent `stagingDomain`, et
  `shopctl deploy --env staging` avertit quand une preview privée n'en déclare
  aucun.

### Amendement (2026-10-27) — la preview devient facultative

Le pilote a passé les quatre étapes, et la deuxième a coûté plus qu'elle n'a
rapporté : une application Access, son jeton de service, le contournement du
webhook, les secrets du nocturne de staging, puis la destruction et les
révocations, soit 45 min à 1 h par boutique, pour montrer au commerçant une
boutique qu'il saisit ensuite lui-même sur son compte. Sur une boutique de
quelques heures, vendue quelques centaines d'euros, c'est le poste le plus
lourd de la mise en ligne ([certification par boutique](../../certification/par-boutique.md)).

Décidé par Damien le 2026-10-27 : **par défaut, la boutique se construit
directement en production sur le compte du client**, et les étapes 1, 2 et 4
de la décision se réduisent à une seule. La preview privée sur le compte de
l'agence reste possible quand un commerçant veut voir avant de donner son
compte ; tout ce qui précède s'applique alors tel quel.

Une production construite en public demande qu'elle reste fermée jusqu'à
l'ouverture. Deux protections existaient : le mot de passe de
l'administration, posé avant le premier déploiement (`shopctl admin
password`), et le paiement de démonstration coupé par `provision`, qui fait
dire au panier que la commande est indisponible. Une troisième entre dans le
socle avec cet amendement : **tant qu'aucun moyen de paiement réel n'est
ouvert, la vitrine demande aux moteurs de ne pas l'indexer** (`<meta
name="robots" content="noindex">`, `src/features/storefront/indexable.ts`).
Sans elle, un catalogue à moitié saisi est ce que les résultats de recherche
retiennent. Le premier moyen réel l'ouvre, sans déploiement ; un catalogue
dont le panier est coupé par choix reste indexé.

Le nocturne n'interroge plus qu'un staging **déclaré** — `stagingDomain` dans
le manifeste, ou la variable de dépôt `STAGING_URL` — et le dit quand il n'y
en a pas : une boutique sans preview n'a pas de nuit rouge à expliquer.

La frontière entre les comptes ne bouge pas : les données ne vivent jamais
que sur le compte du client, et il n'y a toujours aucune migration à écrire.

## Alternatives écartées

- **Frontière à la mise en ligne** (construire ET faire saisir sur le compte de
  l'agence, puis basculer) : la séquence la plus confortable commercialement, et
  celle qui impose une migration de données à chaque livraison. Elle fait
  arriver le jalon 9 avant le jalon 7 et met l'agence en possession des données
  d'un client pendant toute la phase de saisie.
- **Tout sur le compte du client dès l'étape 1** : bloque le démarrage sur une
  action du client avant même qu'il ait vu quoi que ce soit.
- **Une preview publique avec une URL non devinable** : une URL n'est pas un
  contrôle d'accès. Elle est dans l'historique du navigateur, dans les en-têtes
  `Referer` et dans les journaux de tout ce que la page appelle.
- **Un mot de passe partagé dans le Worker pour la preview** : du code de
  contrôle d'accès dans le cœur, à maintenir et à tester, pour reproduire moins
  bien ce qu'Access fait à la bordure.
- **Garder `staging` sur le compte de l'agence après la mise en ligne** :
  demanderait un compte par environnement, contredirait la propriété unique
  d'ADR 0002, et laisserait des données de test d'un client chez l'agence
  indéfiniment.

## Vérification

- `cloudflare.stagingDomain` ferme `workers_dev` et rend la route en domaine
  personnalisé (`test/scripts/manifest.test.mjs`) ;
- un environnement déclaré privé qui répond 200 à une requête non authentifiée
  fait échouer `shopctl deploy` (`test/scripts/deploy.test.mjs`) ;
- deux boutiques ne peuvent pas revendiquer le même nom d'hôte, preview et
  production confondues : `config:validate` les compare sous une seule clé ;
- `shopctl destroy` refuse sans le slug saisi, refuse une production sans
  `--yes`, supprime la base en dernier et relaie le refus d'un bucket non vide
  sans le vider (`test/scripts/destroy.test.mjs`) ;
- l'application Access n'est rendue que dans le Worker de staging, et une
  moitié d'application est refusée par le manifeste
  (`test/scripts/manifest.test.mjs`, `test/scripts/deploy.test.mjs`) ;
- `provision --env production` vise `productionAccountId` quand il est
  déclaré, et `shopctl repo` donne à chaque environnement son compte
  (`test/scripts/provision.test.mjs`, `test/scripts/repo.test.mjs`) ;
- la vitrine porte `noindex` tant qu'aucun moyen de paiement réel n'est
  ouvert, et plus après (`src/features/storefront/indexable.test.ts`) ;
- le nocturne ne lance ses contrôles de staging que pour un staging déclaré
  et encore en place (`test/scripts/nightly.test.mjs`).
