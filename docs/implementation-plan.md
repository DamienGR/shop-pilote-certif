# Plan d'implémentation du pilote Minshop

## Suivi d'avancement

- [x] tâche terminée et vérifiée dans le dépôt ou l'environnement local ;
- [ ] tâche restant à réaliser ou à valider dans le contexte du pilote.

Une fonctionnalité déjà présente dans Minshop n'est cochée que lorsqu'elle a été
explicitement validée pour l'architecture et les boutiques du pilote.

## 1. Finalité du pilote

Le pilote doit valider la viabilité technique, opérationnelle et économique d'une
offre industrialisée de création de petites boutiques e-commerce sur mesure.

Il doit livrer :

- [ ] une boutique française fonctionnelle, réaliste et déployée ;
- [ ] un socle Minshop français versionné ;
- [ ] une architecture permettant de gérer plusieurs clients ;
- [ ] une CLI de génération et d'exploitation ;
- [ ] des procédures testées de mise à jour, sauvegarde, restauration et sortie —
  mise à jour (jalon 9), sauvegarde et restauration (jalon 8) sont éprouvées ;
  la sortie d'un client reste à écrire ;
- [ ] une campagne de certification réutilisable pour chaque nouvelle boutique.

L'architecture est multi-client au niveau du code et de l'exploitation, mais
chaque boutique reste mono-tenant à l'exécution.

## 2. Périmètre de référence

### 2.1 Inclus dans le pilote

- B2C France ;
- langue `fr-FR` ;
- fuseau `Europe/Paris` ;
- devise EUR ;
- prix TTC ;
- checkout invité ;
- moins de 100 produits ;
- produits simples et variantes ;
- gestion de stock ;
- catégories et recherche FTS ;
- Stripe Checkout ;
- livraison fixe, par poids et franco ;
- codes promotionnels Stripe ;
- e-mails de confirmation et d'expédition ;
- pages éditoriales et légales ;
- export des commandes ;
- sauvegarde et restauration ;
- administration protégée par Cloudflare Access et Turnstile.

### 2.2 Hors périmètre

- multilingue ;
- multidevise ;
- abonnements ;
- marketplace ;
- B2B avancé ;
- points relais ;
- tarifs transporteur en temps réel ;
- ERP, caisse ou comptabilité synchronisés ;
- automatisation marketing ;
- personnalisation produit complexe ;
- recherche sémantique ;
- Lightning, OpenNode et MCP.

### 2.3 Jeux de données témoins

Deux boutiques fictives doivent exister dès le début du développement :

#### `pilot-fr`

- [x] vingt produits ;
- [x] plusieurs catégories ;
- [x] produits simples et variantes ;
- [x] états en stock, stock faible et épuisé ;
- [ ] livraison fixe, par poids et gratuite au seuil ;
- [x] thème entièrement personnalisé — `atelier`, jalon 5 ;
- [ ] pages légales fictives clairement identifiées comme telles.

#### `canary-minimal`

- [x] cinq produits — `catalogue/catalog.csv`, la contre-épreuve du format : le
  fichier du pilote remplit les quatorze colonnes, donc un import devenu
  exigeant sur l'une des dix facultatives y resterait vert et casserait sur le
  premier fichier du marchand suivant. Celui-ci remplit les trois obligatoires
  et la seule dont sa boutique a une opinion — aucune catégorie, aucune image,
  aucune variante, aucun poids ;
- [x] thème différent ;
- [x] fonctionnalités minimales ;
- [x] utilisée pour vérifier l'absence de configuration codée en dur pour le pilote.

Les manifestes des deux boutiques existent depuis le jalon 1
(`test/fixtures/clients/`) et la CI construit les deux. Ce qui manque tient au
catalogue (jalon 4) et au thème propre du pilote (jalon 5).

## 3. Architecture multi-client

### 3.1 Plan de contrôle

Le plan de contrôle comprend :

- [x] le fork du socle `minshop-platform`, avec l'historique Minshop conservé,
  en dépôt privé ;
- [x] la CLI `shopctl` — `new`, `doctor` et `config validate` au jalon 2
  (`shopctl/`, [ADR 0009](architecture/decisions/0009-forme-de-la-cli-shopctl.md)) ;
  provisioning, catalogue, déploiement, sauvegarde et flotte aux jalons suivants ;
- [x] les schémas de configuration ;
- [x] les templates de boutique — trois designs livrés par le socle, plus le
  thème propre à une boutique que `pilot-fr` démontre depuis le jalon 5 ;
- [x] le registre privé de flotte — `fleet.json`, déclaré dans l'espace de
  travail de l'agence ([ADR 0016](architecture/decisions/0016-registre-et-mise-a-niveau-de-la-flotte.md)) ;
- [x] les workflows de mise à jour — `shopctl core upgrade`,
  `shopctl fleet upgrade`, et le workflow `Release` qui publie les tags ;
- [x] les tests génériques propres à la plateforme multi-client —
  `npm run test:tenant-isolation` monte les deux boutiques témoins dans un
  seul compte Cloudflare et une seule forge, et tient les sept premières
  lignes du §8.3. Toutes les autres suites du dépôt éprouvent **une**
  boutique ; le défaut visé ici est celui d'une boutique juste seule et
  fausse à côté d'une autre.

Il ne contient aucune donnée de commande et aucun secret client.

### 3.2 Plan de données

Chaque boutique dispose de ses propres :

- [x] Worker Cloudflare ;
- [x] base D1 ;
- [x] bucket R2 d'images ;
- [x] bucket R2 de fichiers privés ;
- [x] secrets ;
- [x] sauvegardes ;
- [x] domaine ;
- [ ] comptes Stripe et Resend.

Créés par ressource et par environnement au jalon 6, sous la souche
`minshop-<slug>-<env>` ([ADR 0013](architecture/decisions/0013-environnements-de-deploiement.md)).
Les sauvegardes sont un livrable du jalon 8 (§5.6, `shopctl backup` /
`shopctl restore`) ; les comptes Stripe et Resend restent des opérations
humaines, listées par `shopctl doctor`.

Les boutiques européennes utilisent la juridiction Cloudflare `eu` pour D1 et
R2.

- [x] Faire vérifier la juridiction après le provisioning par la CLI.
  Pour R2 le contrôle est à deux faces — présent en juridiction `eu`, absent de
  la juridiction par défaut — parce qu'une reprise ratée peut laisser deux
  buckets de même nom dans deux juridictions. Pour D1, quand l'API ne publie pas
  le champ en retour, le rapport dit « non vérifié » plutôt que « conforme ».

### 3.3 Propriété des fichiers

Les fichiers doivent être divisés en trois catégories :

| Catégorie | Propriétaire | Exemples |
|---|---|---|
| Cœur | Socle agence | paiement, stock, auth, migrations |
| Client | Boutique | thème, manifeste, contenus, assets |
| Généré | Outils | configuration Wrangler, rapports, index |

La CI doit refuser qu'une modification présentée comme une simple
personnalisation client touche un fichier du cœur sans approbation explicite.

- [x] Implémenter ce contrôle de propriété des chemins dans la CI.
  `scripts/path-ownership.mjs` porte la liste des règles ; `.github/CODEOWNERS`
  en est **généré**, parce que deux copies écrites à la main divergent et que
  cette divergence est invisible — CODEOWNERS n'est lu que par GitHub, au moment
  de la revue, sur la pull request de quelqu'un d'autre. Le job « File
  ownership » exécute la porte à chaque pull request. Elle n'a de dents que dans
  une boutique — un arbre qui contient `client/client.yaml` — car ici toute pull
  request touche le cœur ; une porte qui se déclenche à chaque fois n'apprend
  qu'à passer outre. Une boutique lève la porte par le label `core-change` ou un
  trailer `Approves-core-change:`, deux actes délibérés qui restent dans
  l'historique : ce qui est refusé n'est pas la modification du cœur, c'est la
  modification tue.

### 3.4 Stratégie Git

Chaque boutique est créée en clonant un tag du socle, avec son historique Git.

Remotes :

```text
origin  -> dépôt de la boutique
core    -> dépôt agency-minshop-core
```

Une version du socle est un tag immuable. Une boutique ne suit jamais une
branche flottante comme `main`.

Une mise à niveau :

1. [x] récupère un tag ;
2. [x] crée une branche ;
3. [x] merge le tag ;
4. [x] exécute les tests ;
5. [ ] déploie en staging ;
6. [x] ouvre une pull request ;
7. [x] attend une validation humaine avant la production.

Les six étapes cochées sont `shopctl core upgrade --to <tag> --open-pr`
(jalon 9). La cinquième reste une commande qu'un humain tape — `shopctl deploy
--env staging` —, listée dans la checklist que porte la pull request :
l'automatiser reviendrait à déployer sans approbation, ce que le critère de
sortie du jalon 9 interdit.

## 4. Configuration d'une boutique

Le fichier `client/client.yaml` est la source de vérité non sensible.

```yaml
schemaVersion: 1
coreVersion: 0.1.0

client:
  slug: pilot-fr
  displayName: Boutique Pilote
  locale: fr-FR
  timezone: Europe/Paris
  currency: EUR

commerce:
  market: FR
  pricesIncludeTax: true
  checkoutMode: guest
  defaultVatRate: 20
  invoiceStrategy: pending-validation

features:
  customerAccounts: false
  semanticSearch: false
  digitalProducts: false
  promoCodes: true
  shipping: true

cloudflare:
  jurisdiction: eu
  workerName: minshop-pilot-fr
  productionDomain: pilote.example.fr

email:
  provider: resend
  from: commandes@pilote.example.fr

theme:
  id: atelier  # src/themes/atelier/
```

Ce bloc est la copie lisible d'un fichier qui existe :
`test/fixtures/clients/pilot-fr/client.yaml`. En cas de désaccord entre les deux,
c'est la fixture qui a raison — elle est validée à chaque `npm run verify`, ce
bloc ne l'est pas. `coreVersion` y suit la version du socle, donc la valeur
montrée ici vieillit ; c'est le seul champ dont il ne faut pas recopier la
valeur.

Un JSON Schema versionné contrôle :

- [x] les champs obligatoires ;
- [x] les valeurs autorisées ;
- [x] les combinaisons incompatibles ;
- [x] la forme du slug ;
- [x] la convention des noms de ressources ;
- [x] la compatibilité entre la version du manifeste et celle du socle.

La spécification est `scripts/manifest-schema.mjs` ; `schemas/client-1.schema.json`
en est généré et contrôlé contre la dérive. Un seul point d'autorité : deux
documents écrits à la main finissent par annoncer à l'éditeur un champ que le
validateur refuse, et c'est l'éditeur que le commerçant croit. Les règles qu'un
JSON Schema ne peut pas exprimer — le nom du Worker suit le slug, un checkout
invité n'affiche pas de comptes client, la France vend TTC, le domaine de
production est celui du commerçant — sont nommées et vérifiées par
`validateManifest()`, et listées dans le schéma publié sous `x-crossFieldRules`
pour qu'un validateur générique ne soit pas pris pour la porte.

Les énumérations n'acceptent aujourd'hui qu'une valeur pour `locale`,
`currency`, `market` et `jurisdiction`. C'est délibéré : élargir l'une d'elles
est une décision de version de schéma avec des notes de migration, ce qui est
exactement la différence entre un marché supporté et un marché non testé.

Le format, l'autorité de la spécification et la dérivation des noms de
ressources sont consignés dans
l'[ADR 0008](architecture/decisions/0008-format-du-manifeste-client.md), avec
les alternatives écartées.

Les clés API et secrets sont interdits dans le manifeste.

- [x] Faire appliquer cette interdiction par le schéma et les contrôles de CI.
  Le schéma est fermé (`additionalProperties: false` à tous les niveaux), donc un
  champ `stripeKey:` inventé est refusé d'office ; la règle `no-credentials`
  couvre l'autre forme, un secret collé dans un champ autorisé. Le manifeste
  étant committé, une valeur qui arrive là est publiée à tous les clones.

## 5. CLI `shopctl`

### 5.1 Technologie

- [x] Node.js 22 ;
- [x] JavaScript ESM annoté JSDoc, sans étape de build ;
- [x] dépendances minimales — aucune ;
- [x] appels à Wrangler encapsulés ;
- [x] sortie humaine par défaut ;
- [x] sortie machine avec `--json` ;
- [x] codes d'erreur stables ;
- [x] journalisation structurée sans secret.

Ce plan annonçait « TypeScript ». Le jalon 2 a mis l'annonce à l'épreuve et
l'a corrigée : le `tsconfig.json` du dépôt cible le storefront — il inclut tout
l'arbre, épingle `types` aux types Cloudflare Workers et n'embarque pas
`@types/node` —, si bien qu'un fichier `.ts` d'outillage échoue à `astro check`
faute de déclarations pour `node:fs`. C'est déjà pourquoi `scripts/` et
`test/scripts/` sont en `.mjs`. Passer la CLI en TypeScript demanderait un
second `tsconfig`, une dépendance de types et soit une étape de build, soit
`--experimental-strip-types` à chaque invocation — pour un outil qui doit
tourner **avant** qu'il n'existe un `node_modules` quelque part. La contrainte
réelle est le `tsconfig` unique du storefront, pas le langage ; le motif complet
et les alternatives sont dans
l'[ADR 0009](architecture/decisions/0009-forme-de-la-cli-shopctl.md).

### 5.2 Commandes de création

```bash
shopctl new <slug>
shopctl doctor
shopctl config validate
```

`config validate` existe déjà sous la forme de `npm run config:validate`
(`scripts/check-manifest.mjs`), livré au jalon 1 et exécuté par `verify` : il
valide les manifestes, refuse deux boutiques sur un même identifiant de
ressource, contrôle la dérive du schéma publié et vérifie qu'aucune valeur
client n'est écrite dans le cœur. La commande l'**enveloppe**, elle ne le
réimplémente pas — sans quoi la CI et la CLI finiraient par répondre
différemment à la même question, et c'est la CLI que l'exploitant croit. Sous
`--json`, elle relaie le document de la porte tel quel, et un test compare les
deux sorties : la divergence est impossible, pas seulement improbable.

Deux défauts appartiennent à l'**agence** et pas au **socle**, et vivent donc
dans l'environnement plutôt que dans le code : `MINSHOP_DOMAIN_SUFFIX` fait de
`--domain` un `<slug>.<suffixe>`, et `CLOUDFLARE_ACCOUNT_ID` sert de `--account`.
Les écrire en dur serait impossible de toute façon — `config:validate` échoue sur
tout fichier du cœur contenant le domaine d'une boutique — et ce serait surtout
un socle qui connaît une agence, donc invendable à la seconde.

`shopctl new` s'appelle aussi **sans cloner le socle**, ce qui est la forme que
prend la toute première boutique d'une machine :

```bash
npx --package=github:<owner>/<socle>#v1.0.0 shopctl new <slug>
```

`--package=` est obligatoire — le paquet et la commande n'ont pas le même nom —
et le `#<tag>` répond à la même question que `--core`, ce qui est exactement la
propriété d'ADR 0009 : la CLI qui écrit le manifeste est celle que le tag cloné
transporte. npm livre un **tarball**, sans remote `origin` : le défaut de
`--from` retombe alors sur le champ `repository` du `package.json` du socle. Un
arbre cloné garde la priorité, parce qu'une bifurcation ou un miroir est le
socle devant lequel l'exploitant se tient.

`shopctl new` doit :

1. [x] valider le slug et les options ;
2. [x] sélectionner un tag précis du socle ;
3. [x] cloner ce tag avec son historique ;
4. [x] renommer le remote du socle en `core` ;
5. [x] configurer le futur remote `origin` si fourni ;
6. [x] créer le manifeste ;
7. [x] générer un thème client à partir de la référence choisie ;
8. [x] générer le répertoire `imports/` — sans exemple de catalogue : le format
   CSV contractuel est un livrable du jalon 4, et un gabarit inventé avant lui
   serait recopié dans chaque boutique générée d'ici là, puis rempli par le
   commerçant ;
9. [x] installer les dépendances sauf option contraire ;
10. [x] exécuter une vérification minimale — les portes que la **boutique**
    transporte (`check-manifest.mjs`, `check-paths.mjs`), pas celles du socle
    hôte, et sans `node_modules` ;
11. [x] présenter les prochaines actions ;
12. [x] écrire le compte Cloudflare attendu, depuis `--account` ou
    `CLOUDFLARE_ACCOUNT_ID` ; le rapport dit laquelle des deux a répondu ;
13. [x] créer le dépôt GitHub, ses environnements et leurs secrets sur
    `--create-repo` — voir §5.2 bis.

### 5.2 bis Forge

```bash
shopctl repo
shopctl repo --reviewer <login>
shopctl new <slug> --account <id> --create-repo --reviewer <login>
```

Ajouté au jalon 6, hors du plan initial, parce que la question « combien de
gestes manuels pour une nouvelle boutique » a une réponse mesurable et qu'elle
était de neuf. `shopctl repo` crée ou confirme :

- [x] le dépôt GitHub, **privé** par défaut, déduit en `<owner>/shop-<slug>`
  quand ni `--origin` ni le remote de l'arbre ne le nomment ;
- [x] la branche sur le remote ;
- [x] les environnements `staging` et `production` ;
- [x] leurs secrets `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID` ;
- [x] les relecteurs obligatoires en production, quand le plan GitHub les permet.

Rejouable comme `provision` : chaque étape interroge GitHub avant d'écrire, un
second passage ne crée rien et ne pousse rien.

La commande **enveloppe `gh`**, et ce n'est pas une préférence
([ADR 0014](architecture/decisions/0014-automatisation-de-la-forge.md)) : un
secret d'environnement GitHub est chiffré en sealed box libsodium — X25519,
Blake2b, XSalsa20-Poly1305 — et Node 22 ne fournit pas le dernier. Une CLI sans
dépendance ne peut donc pas chiffrer un secret pour GitHub ; `gh secret set` le
fait déjà correctement.

### 5.3 Provisioning

```bash
shopctl provision --env staging --dry-run
shopctl provision --env staging
shopctl provision --env production
```

Le provisioning crée ou vérifie :

```text
minshop-{slug}-{env}
minshop-{slug}-{env}-db
minshop-{slug}-{env}-images
minshop-{slug}-{env}-files
```

Il doit :

- [x] vérifier `wrangler whoami` ;
- [x] comparer l'account ID au manifeste ou à l'état attendu ;
- [x] vérifier l'activation préalable de R2 ;
- [x] créer D1 et R2 avec la juridiction `eu` ;
- [x] garder le bucket de fichiers privé ;
- [x] générer les secrets internes avec une source cryptographique ;
- [x] transmettre les secrets à Wrangler par entrée standard ;
- [x] ne jamais les écrire sur disque ou dans les logs ;
- [x] appliquer les migrations ;
- [x] produire un rapport des ressources créées ;
- [x] reprendre proprement après une interruption.

Livré au jalon 6. Le compte attendu n'est jamais deviné : il vient du manifeste
(`cloudflare.accountId`), de `--account` ou de `CLOUDFLARE_ACCOUNT_ID`, deux
sources qui divergent arrêtent l'exécution, et aucune source du tout l'arrête
aussi — un jeton qui n'atteint qu'un compte aujourd'hui en atteindra deux au
client suivant. La reprise ne repose sur aucun fichier d'état : chaque étape
interroge le compte, si bien qu'un second passage ne crée rien et qu'un passage
interrompu reprend sans option particulière.

La création de comptes, l'invitation des utilisateurs et l'activation de Stripe
restent des opérations humaines dans la première version.

- [x] Faire détecter ces prérequis par `shopctl doctor` et fournir une checklist.
  `doctor` sépare trois niveaux : ce qui bloque maintenant (toolchain, `git`,
  identité Git), ce qui bloquera le provisioning (`wrangler` absent ou non
  authentifié) et ce qui reste humain — propriété du compte, activation de R2,
  invitations, activation Stripe, domaines. Prétendre vérifier la dernière
  catégorie serait pire que la nommer.

### 5.4 Catalogue

```bash
shopctl catalog validate ./imports/catalog.csv
shopctl catalog import ./imports/catalog.csv --dry-run
shopctl catalog import ./imports/catalog.csv
shopctl catalog report
```

L'import doit être :

- [x] validé avant toute écriture ;
- [x] idempotent par SKU ;
- [x] capable de reprendre ;
- [x] explicite sur les créations et mises à jour ;
- [x] capable de traiter les images ;
- [x] capable de refuser un changement destructif non demandé.

Livré au jalon 4. Trois options portent les changements que l'import refuse
autrement : `--allow-slug-change`, `--allow-remove-variants` et
`--create-categories`. `--remote` vise la base déployée ; l'omission vise la base
locale, jamais l'inverse.

### 5.5 Vérification et déploiement

```bash
shopctl verify --env staging
shopctl deploy --env staging
shopctl deploy --env production
```

Le déploiement production suit cet ordre :

1. [x] vérification complète ;
2. [x] sauvegarde ou bookmark ;
3. [x] migrations additives ;
4. [x] upload d'une nouvelle version ;
5. [ ] smoke test avant promotion lorsque possible ;
6. [x] promotion ;
7. [x] smoke test public ;
8. [x] rollback du code en cas d'échec.

- [x] Vérifier que les migrations restent compatibles avec la version applicative
  précédente.

`shopctl deploy --env production --yes` exécute cette séquence, et l'ordre y est
une décision plutôt qu'une habitude. Le bookmark Time Travel est pris **avant**
les migrations, seul moment où il décrit encore l'état d'où le déploiement est
parti ; c'est un filet court terme et le rapport le dit, la sauvegarde de
référence restant applicative (ADR 0005). Les migrations passent **avant**
l'upload : il existe entre les deux une fenêtre où l'ancien code tourne sur le
nouveau schéma, ce qui est exactement la fenêtre que la règle additive d'ADR 0006
rend sûre.

L'étape 5 — smoke test **avant** promotion — reste ouverte, et le plan la
formule déjà ainsi (« lorsque possible ») : elle demande un déploiement en
version non promue avec une URL de prévisualisation, donc les déploiements
graduels de Cloudflare. Ce que le jalon 6 livre est le smoke test **public**,
après promotion, qui fait échouer la commande et nomme la version vers laquelle
revenir — commande complète, identifiant déjà résolu. Le rollback n'est pas
automatique : il se déclencherait aussi sur un contrôle qui a échoué parce que
le réseau n'atteignait pas le site, et défairait un déploiement sain.

La compatibilité ascendante des migrations est tenue par
`test/scripts/migrations-remote-safe.test.mjs` et par la politique d'ADR 0006 :
une migration n'ajoute jamais que du facultatif, ce qui est précisément ce qui
rend l'ordre ci-dessus sûr.

### 5.6 Sauvegarde et restauration

```bash
shopctl backup --env production
shopctl backup list
shopctl backup verify <backup-id>
shopctl restore --env staging --from <backup-id>
```

Une restauration vers la production nécessite une option dédiée et une
confirmation saisie par l'opérateur.

- [x] Exiger cette option et cette confirmation, sans jamais faire de la
  production le comportement par défaut. La même posture s'applique déjà au
  déploiement : `shopctl deploy --env production` refuse de s'exécuter sans
  `--yes`, et la production n'est le défaut de rien. `restore --env production`
  exige `--allow-production` **et** `--confirm <slug>` ; une base où la boutique
  a déjà écrit exige `--overwrite` en plus.

Deux commandes s'ajoutent à celles du plan initial, parce que l'ADR 0005 les
appelle sans les nommer :

```bash
shopctl backup keygen            # la clé, écrite une fois, jamais affichée
shopctl backup prune             # la politique de conservation, appliquée
```

### 5.6 bis Droits des personnes

```bash
shopctl privacy export --env production --email <adresse>
shopctl privacy anonymize --env production --email <adresse> --confirm <slug>
```

Deux droits du RGPD s'exercent contre la base de la boutique : l'accès et la
portabilité (articles 15 et 20), l'effacement (article 17). Le second entre en
conflit avec les dix ans de conservation qu'impose le Code de commerce à une
commande payée, et c'est ce conflit qui donne sa forme à la commande.

- [x] **Un effacement est une anonymisation.** Les montants, la TVA, les dates
  et l'identifiant public d'une commande restent ; l'identité est remplacée.
  Le pseudonyme est tiré au hasard, une valeur par ligne, et rien ne conserve
  la correspondance — un condensat de l'adresse se réidentifie par énumération.
  La seule ligne supprimée est un jeton d'accès invité, qui ouvre encore la
  page d'une commande anonymisée.
- [x] **L'export est en clair, en JSON, et destiné à la personne.** C'est le
  format que l'article 20 demande. Il ne porte ni jeton, ni identité d'opérateur
  de la boutique : un export est une divulgation.
- [x] **La carte des colonnes personnelles est déclarée et gatée** ; la
  découverte des lignes est dérivée des clés étrangères. Voir
  [ADR 0017](architecture/decisions/0017-effacement-et-portabilite.md).

### 5.7 Gestion du socle et de la flotte

```bash
shopctl core status
shopctl core upgrade --to v1.1.0
shopctl fleet status
shopctl fleet verify
shopctl fleet upgrade --to v1.1.0 --open-pr
shopctl fleet report --format json
```

Livrées au jalon 9. La flotte est déclarée dans un `fleet.json` de l'espace de
travail de l'agence — jamais découverte par balayage — et une mise à niveau
fusionne un tag sur une branche puis ouvre une pull request : elle ne déploie
rien ([ADR 0016](architecture/decisions/0016-registre-et-mise-a-niveau-de-la-flotte.md)).
Côté socle, `npm run check:release` tient d'accord la version, les manifestes
témoins et les notes de migration, et le workflow `Release` pose le tag après la
suite complète.

## 6. Jalons détaillés

### Jalon 0 — Baseline reproductible

Durée indicative : 2 jours.

#### Livrables

- [x] fork privé de Minshop (`DamienGR/minshop-platform`, visibilité privée
  confirmée le 2026-08-28) ;
- [x] référence upstream enregistrée ;
- [x] versions Node et npm imposées (`engines` racine et `mcp/`,
  `engine-strict`, `.nvmrc` lu par la CI, `npm run check:toolchain`) ;
- [x] lockfiles conservés pour l'application et le Worker MCP ;
- [x] CI minimale héritée de Minshop ;
- [x] inventaire des dépendances et fonctionnalités
  ([`docs/architecture/baseline-inventory.md`](architecture/baseline-inventory.md)) ;
- [x] premiers ADR dans `docs/architecture/decisions/`.

ADR initiaux :

- [x] modèle d'isolation ;
- [x] propriété des comptes ;
- [x] versionnement du socle ;
- [x] localisation des données ;
- [x] stratégie de sauvegarde ;
- [x] politique des migrations ;
- [x] périmètre fonctionnel de l'offre.

#### Tests

- [x] `npm ci` avec Node 22 ;
- [x] contrôles composant `npm run verify` ;
- [x] `npm run build` ;
- [x] `npx wrangler deploy --dry-run` pour le storefront
  (`npm run check:deploy`, inclus dans `npm run verify`).

Ajouter :

- [x] scan de secrets (`npm run check:secrets`) ;
- [x] audit npm des dépendances racine et MCP sans vulnérabilité connue ;
- [x] contrôle de la taille du bundle (budgets Worker et JS client dans
  `scripts/check-deploy.mjs`) ;
- [x] construction depuis un clone vierge (`npm run check:clean-clone`, job CI
  dédié).

#### Critère de sortie

- [ ] Le fork non personnalisé se construit, passe les tests Minshop et peut être
  déployé dans un compte Cloudflare de test.

État : la construction et la déployabilité sont vérifiées automatiquement
(`npm run verify` et le job « Build from a clean clone » couvrent `npm ci`, le
build, le dry run de déploiement, les budgets de taille et le scan de secrets).
Des deux points qui restaient ouverts, un seul subsiste :

- [x] **un déploiement réel dans un compte Cloudflare de test**, effectué le
  2026-08-29 sur l'instance `minshop-test`, vérifié puis détruit. Voir
  « Déploiement de validation » ci-dessous ;
- [ ] **la fiabilité de l'intégration D1 en CI n'est pas encore établie**. La
  mitigation est appliquée ; il reste à l'observer sur la durée. Voir « Défaut de
  baseline connu » ci-dessous.

#### Déploiement de validation sur l'instance `minshop-test`

`scripts/provision-cf.sh minshop-test` a produit une instance complète sur un
compte Cloudflare personnel, en plan gratuit, sans intervention manuelle :

| Ressource | Vérification |
| --- | --- |
| Worker `minshop-test` | déployé ; `/` redirige vers `/admin/setup`, qui répond 200 |
| D1 `minshop-test-db` | 40 migrations sur 40 appliquées, région WEUR |
| R2 | `minshop-test-images` et `minshop-test-files` créés |
| KV | `minshop-test-session` auto-provisionné par l'adaptateur, sous le nom qu'attend `destroy-cf.sh` |
| Secrets | `AUTH_SECRET` et `SECRETS_KEK` posés |
| Bindings déployés | `DB`, `BUCKET`, `FILES`, `SESSION`, les trois rate limiters, `ASSETS` |
| Cron | `*/5 * * * *` enregistré |
| Observabilité | logs et traces actifs, échantillonnage à 100 % |

`scripts/destroy-cf.sh minshop-test` a ensuite tout retiré du compte : Worker,
base D1, les deux buckets et le namespace KV. Le fichier de métadonnées de
l'instance a été supprimé, ce que le script ne fait que si le bucket de fichiers
privés a bien pu être détruit.

Un défaut du script a été trouvé à cette occasion. `wrangler d1 create` et
`wrangler r2 bucket create` proposent désormais d'inscrire eux-mêmes le binding
créé dans le fichier de configuration, avec « oui » par défaut dès qu'un
terminal répond. La sauvegarde de `wrangler.jsonc` était prise à l'étape [3/5],
donc après les créations : elle capturait une configuration déjà modifiée, que
le `trap` de sortie restaurait ensuite fidèlement. Le `wrangler.jsonc` committé,
celui que lisent le bouton « Deploy to Cloudflare » et `astro dev`, s'est
retrouvé avec deux buckets d'instance en trop. Le déploiement, lui, n'a jamais
été affecté : l'étape [5/5] part de la configuration rendue depuis
`wrangler.template.jsonc`, et le Worker a bien reçu les seuls bindings attendus.
Corrigé par [PR #10](https://github.com/DamienGR/minshop-platform/pull/10) :
sauvegarde déplacée avant le premier appel distant, et `--update-config=false`
sur les trois créations pour refuser la proposition à la source.

#### Défaut de baseline connu — intégration D1 instable en CI

`npm run verify` passe en local et échouait une fois sur deux dans GitHub
Actions, toujours au même endroit : la requête qui suit le POST de purge de
cache (`assert_cache_control /product/sample-tee`,
`test/integration/d1-integration.sh:376`) n'atteint jamais le Worker et reçoit
un HTTP 500 dont le corps est `Error: Network connection lost.` levé par
l'entry worker de miniflare.

Cinq échecs et deux passages sur les versions d'origine, dont un échec et un
passage sur **deux commits dont le code est identique** (seule la documentation
change entre eux) : la panne est intermittente, avec un taux d'échec élevé. Elle
est présente sur `main` (`27334e0`) avant tout travail du jalon 0, donc
indépendante de celui-ci.

##### Mitigation appliquée

Un garde-fou existait déjà pour la même classe de panne — `assert_cache_control`
réessaie lorsque curl n'obtient aucune réponse — mais il ne couvrait pas ce cas,
où miniflare répond : la panne de transport arrive habillée en échange HTTP
complet, `curl_rc` reste à 0 et le retry ne partait jamais.

Le retry couvre désormais ce cas, reconnu à sa signature exacte : HTTP 500 dont
le corps porte à la fois `Error: Network connection lost.` et
`core/entry.worker.js`. Une 500 produite par le Worker lui-même ne correspond à
aucun des deux marqueurs et échoue toujours au premier essai — aucune assertion
n'est désactivée, et le compromis retenu en `c964bf7` (ne jamais réessayer un
échange complété) est conservé partout ailleurs. Après trois tentatives, l'échec
nomme la coupure au lieu d'un `cache-control` vide.

##### Deux causes possibles, non départagées

La montée « minor-and-patch » (#1) avait fait passer wrangler de 4.118 à 4.125,
donc le miniflare embarqué de la série 4 à la série 5. Les deux exécutions
vertes qui ont suivi sont **antérieures** à la mitigation : elles peuvent
s'expliquer par cette montée, ou par le hasard sur une panne intermittente. La
mitigation supprime une classe de panne prouvée ; elle ne prouve pas à elle
seule que la panne a disparu.

Exécutions de `verify` sur `main` :

| Commit | Résultat |
| --- | --- |
| `b169b03` | échec |
| `27334e0` | échec |
| `a3e1c1f` | vert — wrangler 4.125 / miniflare 5 |
| `deaf9de` | vert |
| `01e992f` | annulé |
| `e7c1526` | vert — première exécution avec la mitigation |
| `40ab093` | vert |
| `c1a066d` | vert |
| `10e53b2` | annulé (poussée suivante arrivée par-dessus) |
| `ea1d870` | vert |
| `0d2bc65` | échec |

La panne n'a pas disparu pour autant. Le 2026-08-29 elle s'est reproduite trois
fois au même endroit, mitigation comprise : sur la branche de la
[PR #9](https://github.com/DamienGR/minshop-platform/pull/9)
([run 33270596059](https://github.com/DamienGR/minshop-platform/actions/runs/33270596059)),
sur `main` en `0d2bc65`
([run 33275634908](https://github.com/DamienGR/minshop-platform/actions/runs/33275634908)),
puis sur la branche de la [PR #12](https://github.com/DamienGR/minshop-platform/pull/12)
([run 33276600401](https://github.com/DamienGR/minshop-platform/actions/runs/33276600401)),
avec la même sortie :

```
(retrying GET /product/sample-tee — miniflare dropped the connection, HTTP 500)
(retrying GET /product/sample-tee — curl exit 7, no response)
D1 integration failed: GET /product/sample-tee — no response after 3 attempts (curl exit 7).
```

L'échec de `0d2bc65` remet le compteur à zéro, après quatre exécutions vertes
accumulées depuis la mitigation.

La série en cours repart de `4cb945a`, première exécution avec la relance à
quatre essais et le second runner. La table s'arrête là volontairement : au-delà
le compte se lit dans les exécutions du workflow `Verify` sur `main`, et
recopier ici une ligne par fusion produirait surtout des mises à jour oubliées.
Ce qui mérite d'être consigné, c'est un échec, parce qu'il remet le compteur à
zéro et qu'il serait alors d'une nature nouvelle : quatre tentatives et un
runner neuf n'ont plus rien de commun avec la panne décrite ci-dessus.

##### Cause identifiée

Le retry part bien sur la 500 de miniflare, puis les deux tentatives suivantes
n'obtiennent rien : `curl exit 7`, le port n'écoute plus. Ce n'est donc pas une
connexion qui tombe, c'est `wrangler dev` qui meurt. Les trois journaux se
terminent à l'identique, juste après le POST de purge signé invalide :

```
[wrangler:info] POST /api/internal/cache-purge 401 Unauthorized (3ms)

✘ [ERROR]

If you think this is a bug then please create an issue at .../workers-sdk/issues/new/choose
🪵  Logs were written to "/home/runner/.config/.wrangler/logs/wrangler-….log"
```

C'est
[cloudflare/workers-sdk#15317](https://github.com/cloudflare/workers-sdk/issues/15317),
régression de [#4562](https://github.com/cloudflare/workers-sdk/issues/4562)
apparue avec wrangler 4.125 : sous contention, le proxy de développement perd
une connexion en cours de réponse ; wrangler remonte l'incident en
« Error inside ProxyWorker » **fatal**, et le message affiché est vide parce que
l'erreur sérialisée à travers la frontière du worker ne peut pas être
reconstruite en `Error`. La session entière tombe.

Cela explique la chronologie complète. Avant 4.125, l'incident se manifestait en
500 rendue par l'entry worker, serveur toujours debout : le retry de `e7c1526`
aurait suffi. Depuis 4.125, le même incident tue la session, et aucun retry sur
la requête ne peut plus rien puisqu'il n'y a plus rien en face. La montée à
4.127.1 ne change pas ce comportement, ce que l'échec de la
[PR #12](https://github.com/DamienGR/minshop-platform/pull/12) a confirmé.

##### Mitigation retenue

La panne est sous le plancher du dépôt et le correctif appartient à l'amont. Ce
qui est à notre portée est de ne pas transformer une session de développement
morte en échec de certification :

- `d1-integration.sh` distingue désormais cette mort du reste et sort en **75**,
  code réservé à ce seul cas ; une assertion en échec sort toujours en 1 ;
- `run-d1-integration.sh` relance la suite jusqu'à **quatre fois**, et
  uniquement sur 75. Une assertion en échec n'est jamais rejouée : une porte qui
  rejoue les vraies régressions n'est plus une porte ;
- la CI exécute `verify` sur un **second runner** quand le premier n'a pas
  abouti, parce que la panne se répète sur une même machine et pas sur une
  autre. Le workflow `Release` fait de même depuis qu'il a été pris à son
  propre piège : il exécutait la suite **une seule fois**, et la première
  publication de la v0.2.0 est morte sur `wrangler dev died on all 4 runs` —
  cinq pour cent de chance de perdre une publication qui n'avait rien prouvé
  sur le commit. Une porte qui ne survit pas au défaut que le dépôt documente
  n'est pas une porte, c'est un tirage ;
- le journal de débogage de wrangler est écrit dans le répertoire d'état et
  affiché à la mort, au lieu de rester dans `~/.config/.wrangler/logs` que
  personne n'archive. C'est là que se trouve la trace que le `✘ [ERROR]` vide
  ne montre pas ;
- `X_LOCAL_EXPLORER=false` rejoint `X_LOCAL_OBSERVABILITY=false` : un service
  interactif de moins attaché au proxy de développement, inutile dans une porte
  sans opérateur.

##### Une cause voisine, longtemps comptée comme la même

La porte se liait à un port fixe (`8791`). Deux exécutions sur une même machine
entraient donc en collision : la seconde ne pouvait pas se lier, `wrangler dev`
mourait au démarrage, et la mort d'une session est précisément ce que le
wrapper rejoue — quatre fois, sur un port toujours occupé, avant de conclure
« la session est morte aux quatre tentatives ». Le diagnostic affiché nommait
`cloudflare/workers-sdk#15317`, qui n'y était pour rien.

Le cas est devenu ordinaire au jalon 2 : vérifier le socle et une boutique
générée, c'est exécuter la même porte deux fois côte à côte.

Le correctif a demandé deux essais, et les deux méritent d'être notés parce que
le premier avait l'air suffisant. Chercher un port libre puis le passer à
wrangler **ne suffit pas** : la sonde doit refermer la socket avant que wrangler
puisse s'y lier, et deux exécutions lancées ensemble reçoivent le même port.
Ce n'est pas théorique — c'est arrivé au premier essai en parallèle. Seule une
liaison unique, dans le processus qui garde la socket, ferme la fenêtre : d'où
`--port 0`, le noyau attribuant à la liaison, et la suite relit le port dans la
ligne « Ready on » de wrangler.

Le même problème s'est présenté une seconde fois à trois exécutions
simultanées : wrangler ouvre **aussi** un port de devtools, fixe par défaut, qui
collisionnait à son tour une fois le port applicatif réglé. `--inspector-port 0`
le règle, et une porte sans opérateur n'a de toute façon pas de devtools à
attacher.

Enfin, un échec de liaison est reconnu à sa signature, cite ce que wrangler a
écrit, et **n'est pas rejoué** — une seconde tentative se heurterait au même
occupant. Cela compte pour le critère de clôture ci-dessous : une collision de
port comptée comme une session morte fausse la mesure qu'il demande.

Vérification : trois exécutions concurrentes de la porte passent toutes les
trois ; avant le correctif, la première collision arrivait dès deux.

##### Mesurer au lieu d'attendre

Accumuler dix exécutions vertes une fusion à la fois prend des semaines.
`.github/workflows/d1-flake-probe.yml` exécute la porte dix fois en parallèle,
sur demande ou sur une branche `flake-probe/**`, et distingue les trois issues :
succès, session morte, assertion en échec. Le mode `raw` mesure la panne, le
mode `wrapped` exécute ce que la CI exécute. Une sonde donne en quelques minutes
ce que le compteur donne en semaines.

Ce que les sondes ont établi, et qui a dicté toutes les décisions ci-dessus :

| Mesure | Résultat |
| --- | --- |
| suite brute, 20 exécutions | 5 sessions mortes, aucune assertion en échec |
| wrapper à 3 tentatives, 30 exécutions | 3 échecs, soit 10 % |
| wrapper à 8 tentatives, 20 exécutions | 1 échec, soit 5 % |

Deux enseignements. D'abord les tentatives ne sont pas indépendantes : un runner
se range dans l'une de deux catégories, celui qui récupère et le fait toujours
tôt (toutes les récupérations observées sont tombées aux tentatives 2, 3 ou 4),
et celui qui meurt à chaque essai, y compris huit fois de suite. L'arithmétique
en p^n ne s'applique pas. Ensuite, relancer sur place plafonne à 5 % : aucun
nombre de tentatives sur une machine qui ne récupère jamais ne fabrique un
passage. D'où le second runner, seul tirage réellement neuf, qui ramène le
résidu attendu autour d'une exécution sur quatre cents.

- [ ] Rendre l'intégration D1 fiable en CI. **Critère de clôture : dix
  exécutions vertes consécutives de `verify` sur `main`**, mitigation comprise.
  Avec un taux d'échec historique proche d'une fois sur deux, dix passages
  consécutifs ramènent sous 0,1 % la probabilité de conclure à tort ; sans seuil
  chiffré, la case ne peut pas être fermée objectivement. Tant que l'intégration
  échoue par intermittence, elle ne peut pas servir de porte de certification
  pour une boutique, et le critère de sortie du jalon 0 n'est pas atteint.

Le diagnostic initial et les exécutions comparées sont consignés sur
[PR #1](https://github.com/DamienGR/minshop-platform/pull/1) ; le correctif et
son raisonnement sur
[PR #7](https://github.com/DamienGR/minshop-platform/pull/7).

### Jalon 1 — Fondations multi-client

Durée indicative : 3 à 4 jours.

#### Livrables

- [x] schéma de manifeste (`scripts/manifest-schema.mjs`, publié en
  `schemas/client-1.schema.json`) ;
- [x] conventions de nommage ;
- [x] séparation des fichiers cœur/client/générés
  (`scripts/path-ownership.mjs`) ;
- [x] fixtures `pilot-fr` et `canary-minimal` — au niveau du manifeste ; leur
  catalogue arrive au jalon 4 et le thème du pilote au jalon 5 (§2.3) ;
- [x] règles `CODEOWNERS` ;
- [x] test de politique des chemins.

#### Tests

- [x] manifeste valide ;
- [x] champ inconnu refusé ;
- [x] slug dangereux refusé ;
- [x] nom réservé refusé ;
- [x] doublon de ressource détecté ;
- [x] matrice de build pour les deux boutiques ;
- [x] thème A jamais chargé par B ;
- [x] aucun identifiant de ressource partagé.

#### Critère de sortie

- [x] Deux boutiques différentes se construisent depuis le même socle sans
  condition client codée en dur dans le cœur métier.

#### État

Tout ce qu'une boutique a de particulier vient de son manifeste. Le lecteur
(`scripts/manifest-yaml.mjs`) est écrit à la main et sans dépendance, non par
goût de l'exercice mais parce qu'il doit **refuser** ce qu'il ne comprend pas :
un lecteur YAML complet résout `market: NO` en booléen faux et déplie des
ancres en valeurs que personne n'a tapées. Sur un fichier dont les valeurs
deviennent des noms de ressources dans un compte Cloudflare, « l'analyseur a
été malin » est le mode de défaillance à supprimer par construction.

Les noms de ressources sont **dérivés** du nom du Worker, jamais configurés
séparément. C'est ce qui garantit que `<workerName>*` est l'empreinte complète
d'une boutique, donc que `destroy-cf.sh` la retire entièrement. Et
`detectFleetCollisions` refuse que deux manifestes revendiquent le même
identifiant : rien à l'exécution ne sépare les données de deux boutiques
(ADR 0001), donc un nom de base D1 dupliqué est à un provisioning près de faire
atterrir les commandes d'une boutique chez une autre. Il n'y a pas de garde-fou
applicatif derrière ; ce sont les noms qu'il faut tenir.

Les deux boutiques témoins diffèrent là où le cœur est censé commuter — thème,
promotions, livraison, facturation. Deux fixtures d'accord sur tout auraient
passé tous les contrôles ci-dessus sans rien prouver. La matrice CI « Build
shop » découvre les boutiques dans l'arbre plutôt que dans une liste, comme la
matrice des thèmes, et rend la configuration Wrangler depuis
`wrangler.template.jsonc` — le même gabarit que `provision-cf.sh` — pour qu'une
construction témoin et un provisionnement réel ne puissent pas diverger sur les
bindings.

Le critère de sortie a deux moitiés, et une construction verte ne dit rien de
la seconde : deux boutiques peuvent se construire parfaitement pendant que le
cœur nomme l'une d'elles, et la condition ne se révèle alors qu'à la troisième
boutique, en production. `npm run config:validate` inspecte donc les fichiers du
cœur à la recherche des valeurs qu'une boutique choisit librement — slug, nom
affiché, nom de Worker, domaine, expéditeur — et échoue sur une occurrence ; pas
sur celles qu'il doit connaître (`EUR`, `eu`), qui apparaîtraient partout sans
rien signifier. Le contrôle a trouvé une fuite dès sa première exécution, dans
un commentaire de son propre module.

Vérification locale : `node scripts/prepare-client.mjs <slug>` puis
`THEME=<thème> npm run verify:theme` passe pour les deux boutiques, et
`check-built-css` confirme à chaque fois que les deux thèmes inactifs sont
absents de la feuille construite — c'est la forme exécutable de « thème A jamais
chargé par B ».

### Jalon 2 — Générateur de boutique

Durée indicative : 3 à 5 jours.

#### Livrables

- [x] package CLI (`shopctl/`, livré par le socle et versionné avec lui) ;
- [x] `shopctl new` ;
- [x] `shopctl doctor` ;
- [x] `shopctl config validate` ;
- [x] initialisation Git et remotes ;
- [x] génération du manifeste et du thème ;
- [x] rapport de création, humain et `--json`.

#### Tests

- [x] snapshots du squelette ;
- [x] chemin contenant des espaces ;
- [x] répertoire non vide refusé ;
- [x] tag de socle inexistant ;
- [x] ref qui n'est pas un tag refusé ;
- [x] fonctionnement sans installation avec `--no-install` ;
- [x] aucun secret ou identifiant de test copié ;
- [x] résultat déterministe ;
- [x] boutique générée immédiatement constructible.

#### Critère de sortie

- [x] `shopctl new test-client`, suivi de `npm ci` et `npm run verify` dans
  `shop-test-client`, réussit sans modification manuelle.

#### État

Deux propriétés portent le reste.

**Le manifeste est validé avant le clone.** Toutes les valeurs qu'une boutique
choisit tiennent sur la ligne de commande, et elles passent le validateur du
jalon 1 — le même que la CI — avant qu'un seul octet ne soit écrit. Une valeur
inutilisable coûte un message ; elle ne laisse pas derrière elle un répertoire,
un historique Git et une porte rouge à comprendre.

**Un ref qui n'est pas un tag `v<semver>` est refusé, avant le clone.** C'est le
contrôle qui applique l'ADR 0003 au seul endroit où il peut encore l'être : une
branche se clone parfaitement, et une boutique installée sur `main` ne le
découvrirait qu'à la première mise à niveau, sans version de référence à
laquelle revenir.

Rien n'est supprimé du clone, contrairement à `create-minshop` qui retire
l'historique amont et son propre paquet. Ce sont deux outils pour deux
finalités : le générateur public produit une boutique autonome, `shopctl new`
produit une boutique qui recevra des tags du socle par merge pendant toute la
durée du contrat. Chaque fichier retiré à la création serait un conflit à
re-résoudre à chaque mise à niveau qui y touche.

La CLI **enveloppe** les portes plutôt que de les réimplémenter, et la
vérification minimale de `new` appelle les scripts que la **boutique**
transporte, pas ceux du socle hôte : une boutique doit passer la porte que sa
propre version du socle définit, sinon une mise à niveau serait validée par la
version qu'elle n'a pas encore fusionnée. Le test
« relays the gate's own report » compare la sortie de
`shopctl config validate --json` à celle de `scripts/check-manifest.mjs --json`,
ce qui rend la divergence impossible plutôt qu'improbable.

Le critère de sortie a trouvé un défaut que rien d'autre n'aurait trouvé. La
suite de tests est de propriété `core` : elle est donc **livrée dans chaque
boutique** et s'y exécute telle quelle. Quatre de ses assertions supposaient que
l'arbre courant est le socle — « exactement deux boutiques », « `repository`
vaut `core` », « le premier manifeste découvert est une fixture ». Toutes
passaient ici et échouaient dans la première boutique générée, c'est-à-dire chez
le client, sur un `npm run verify` qui aurait eu l'air d'être de sa faute. Elles
affirment désormais ce qu'elles voulaient dire — les deux témoins sont présents
et passent — et non le décompte de l'arbre.

Le contrôle de neutralité du cœur en a trouvé un second, du même genre : ce
plan et le read-me écrivent `shopctl new acme`, et la porte échoue sur tout
fichier du cœur contenant le slug d'une boutique. Le premier client nommé `acme`
aurait vu échouer un fichier auquel il n'a jamais touché. Les noms que la
documentation emploie — `acme`, `example` — sont donc réservés comme la RFC 2606
réserve `example.com`, et le cœur n'écrit plus d'exemple de slug plausible.

La mesure a montré que le piège dépassait les exemples de documentation. Un nom
de commerçant ordinaire passe sans une seule fuite ; ce qui restait pris, c'est
le **vocabulaire du socle** — `check`, `mcp`, `products`, `clean-clone` — que le
cœur écrit dans ses propres workflows et sa propre prose. `RESERVED_SLUGS`
couvre désormais les préfixes de routes publiques, **dérivés de `src/pages/` par
un test** plutôt que recopiés à la main : une route ajoutée sans réserver son
nom fait échouer la suite, au lieu de libérer le nom en silence.

Cette liste ne pourra jamais être complète — la porte se déclenche aussi sur de
l'anglais ordinaire que le cœur emploie —, et c'est ce qui rend le second
correctif plus important que le premier. `shopctl new` lisait un échec de porte
et concluait « c'est un bug du cœur, pas une mauvaise option ». Pour une
collision de neutralité sur le slug de la boutique elle-même, c'est exactement
l'inverse : le cœur a raison, le nom est mauvais. La commande lit maintenant le
rapport JSON de la porte, distingue les deux cas, nomme les fichiers en cause,
dit de choisir un autre slug et **ne garde rien**. Réserver les noms connus ne
fait qu'avancer l'échec avant le clone.

La première exécution du job CI a trouvé le troisième cas de la même famille,
cette fois dans `new` lui-même : le workflow posait l'identité Git en local dans
le checkout, la boutique est un autre dépôt, et l'échec sortait sous la forme
d'un `git commit exited with status 128` après un clone de 540 fichiers. Les
deux moitiés sont corrigées — le contrôle a lieu **avant** le clone, et il
interroge `git var GIT_AUTHOR_IDENT`, c'est-à-dire la résolution de git
elle-même (config, variables `GIT_AUTHOR_*`, auto-détection). Relire `user.name`
aurait déclaré cassé un runner qui marche, et l'inverse.

Vérification locale : `shopctl new test-client --core v0.1.0`, puis `npm ci`,
`npm ci --prefix mcp` et `npm run verify` dans `shop-test-client`, sans aucune
modification manuelle. En CI, le job « Generated shop » refait la création et
rejoue les portes déterministes de la boutique ; l'intégration D1 et le
`mcp:check` n'y sont pas rejoués, parce qu'ils portent sur un cœur identique à
l'octet près et que le job `verify` les couvre déjà.

### Jalon 3 — Socle français

Durée indicative : 5 à 8 jours.

#### Livrables

- [x] dictionnaires de traduction typés ;
- [x] storefront français ;
- [x] erreurs françaises ;
- [x] e-mails français ;
- [x] décision concernant la traduction de l'admin ;
- [x] `lang="fr"` ;
- [x] formats `fr-FR` ;
- [x] fuseau `Europe/Paris` ;
- [x] checkout Stripe français ;
- [x] pages légales brouillon ;
- [x] version des CGV enregistrée avec la commande.

#### Décision TVA et facturation

Une étude courte doit comparer puis figer :

- [x] prix TTC enregistrés par Minshop ;
- [x] taux par produit ou taux unique ;
- [x] Stripe Tax activé ou désactivé ;
- [x] ventilation de TVA enregistrée avec la commande ;
- [x] reçu Stripe ou véritable facture ;
- [x] génération et numérotation des factures ;
- [x] export destiné à la comptabilité.

Les sept réponses sont figées par
l'[ADR 0010](architecture/decisions/0010-tva-facturation-et-consentement.md),
avec les alternatives écartées : TTC, taux unique par boutique en points de
base, Stripe Tax désactivé, ventilation dans deux colonnes propres, reçu et non
facture au pilote, numérotation différée, et l'export de commandes existant
augmenté plutôt qu'un second export comptable.

Cette décision doit être validée par un comptable ou conseil compétent avant la
commercialisation.

- [ ] Obtenir et consigner cette validation externe.

#### Tests

- [x] format `1 234,56 €` ;
- [x] dates françaises ;
- [x] arrondis de panier ;
- [ ] remises ;
- [x] taux de TVA retenus ;
- [x] accents et Unicode ;
- [x] chaînes manquantes détectées à la compilation ;
- [x] e-mails en français ;
- [x] CGV non publiées par défaut ;
- [x] paiement bloqué sans acceptation ;
- [x] version des CGV capturée ;
- [x] checkout Stripe affiché en français.

#### Critère de sortie

- [ ] Le modèle français de prix, TVA, facturation et consentement est documenté,
  implémenté et validé.

Documenté et implémenté : oui. **Validé : non**, et c'est la validation externe
ci-dessus qui manque. Le critère reste donc ouvert, comme la condition de
déploiement du §9 qu'il alimente.

#### État

Trois propriétés portent le reste.

**La locale est une constante de compilation, pas un réglage.** `client.locale`
n'accepte qu'une valeur au manifeste et l'élargir est une décision de version de
schéma (§4) ; le code dit maintenant la même chose. `features/i18n/locale.ts`
est une feuille sans import — c'est ce qui permet à `money.ts`, qui se documente
comme dépendance-zéro pour rester utilisable depuis du code pur, de formater en
`fr-FR` sans rien perdre. `<html lang>` en est dérivé plutôt que saisi une
seconde fois.

**Une chaîne manquante est une erreur de compilation.** `MessageKey` est dérivé
du catalogue français lui-même, donc `t('clé.inexistante')` ne compile pas et un
second catalogue déclaré `LocaleCatalog` ne peut pas omettre une clé.
`test/i18n/` compile deux fixtures cassées exprès pour le prouver, et un
troisième cas valide pour que l'échec ne vienne pas simplement d'un import
irrésolu — un garde-fou que personne n'a vu échouer ne prouve rien. Ce que le
compilateur ne voit pas, `messages.test.ts` le vérifie : apostrophe
typographique, espace fine insécable avant `? ! ; :`, accents intacts. Les
assertions de format épellent les points de code (U+202F, U+00A0) plutôt que
d'afficher `1 234,56 €`, parce qu'un copier-coller transforme ces deux
caractères en espaces ordinaires sans que la diff le montre.

**Une seule prédicat décide de l'acceptation des CGV.** La case s'affiche et le
serveur refuse exactement quand la page des CGV est publiée. Deux prédicats
auraient fini par diverger, et les deux façons de diverger sont mauvaises : un
formulaire qui demande un accord que personne n'enregistre, ou un serveur qui
refuse une commande que la page ne permettait pas d'accepter.

La frontière de traduction n'est pas « admin / storefront » mais « qui lit »
([ADR 0011](architecture/decisions/0011-langue-de-l-administration.md)).
L'administration reste en anglais au pilote — c'est l'agence qui exploite
(ADR 0002) —, `AdminLayout` garde donc `lang="en"` délibérément (décision
remplacée au jalon 10 par l'[ADR 0018](architecture/decisions/0018-administration-en-francais.md),
qui passe toute l'administration en français), et
`/payment-setup`, atteignable depuis le panier, est en français tout en nommant
en anglais les écrans qui portent ces noms. Les montants et les dates restent
formatés en `fr-FR` partout, admin comprise : une date au format américain dans
un back-office français est une erreur d'exploitation, pas une question de
langue.

Le checkout hébergé Stripe a demandé une correction que rien n'aurait signalée :
c'est le seul écran de l'achat que la boutique ne rend pas, et sa `locale` valait
`auto`, c'est-à-dire le navigateur. Un acheteur dont le navigateur demande de
l'anglais voyait un formulaire de paiement anglais au milieu d'une boutique, de
prix et de CGV français. L'énumération de Stripe est au niveau de la langue, pas
du tag BCP 47, donc la correspondance vit dans l'adaptateur.

Le consentement voyage sur la réservation, et le taux de TVA avec lui. C'est la
seule ligne qui enjambe les deux moitiés d'un achat : l'accord est donné dans la
requête de commande, l'ordre est écrit minutes plus tard par un règlement qui
n'a jamais vu l'acheteur. L'alternative — faire transiter les deux champs par
les métadonnées de chaque canal — offrait quatre occasions de perdre exactement
ce dont dépendent un litige et un contrôle. Le règlement lit la réservation une
fois et appelle `vatIncludedCents()`, plutôt qu'une copie SQL de la même
arithmétique qui finirait par en diverger.

Le refus a lieu **avant** la réservation de stock, et la porte D1 l'affirme sur
le stock plutôt que sur la route : une commande qui ne peut pas aboutir
légalement ne doit pas retirer d'inventaire de l'étagère, quel que soit
l'endroit où le contrôle finira par vivre.

Le balayage de fin de jalon a trouvé ce que la traduction page par page ne
pouvait pas trouver : les messages qui ne vivent dans aucun gabarit. Huit
erreurs partent en redirection depuis `/api/cart` et `/api/checkout` vers
`/cart` ou vers la fiche produit, qui les rendent telles quelles — « Please
choose a option. » restait donc affiché en français au moment le plus coûteux du
parcours. Les noms de pays étaient dans le même cas : `Intl.DisplayNames` était
appelé en anglais alors que ses libellés atteignent l'acheteur, dans le
sélecteur de destination et dans le message qui nomme le pays non desservi. La
leçon vaut au-delà de ce jalon : une chaîne visible n'est pas forcément dans un
fichier de vue.

Deux limites, nommées plutôt qu'implicites.

Les rails qui passent par `/checkout` avant de payer — Lightning, OpenNode et
la démonstration, quand la livraison s'applique — demandent l'acceptation sur
cette page, et non au panier. Un acheteur qui a coché au panier recoche donc à
l'étape finale. Stripe, le rail du pilote, réserve directement et ne coche
qu'une fois. Reporter la case du panier vers `/checkout` par un paramètre
d'URL pré-cocherait une case de consentement, ce qui est précisément ce qu'il
ne faut pas faire.

Le test « remises » reste ouvert. Les codes promotionnels sont appliqués par
Stripe et reviennent dans `discount_cents` ; la ventilation de TVA est bien
prise sur le montant réellement payé, donc après remise, mais aucun test ne
l'exerce contre un code promotionnel réel — ce qui demande une clé Stripe et
appartient au jalon 7.

Deux imports `t` sont signalés inutilisés par `astro check`, qui arrête son
analyse du frontmatter au premier `return` de premier niveau. Ils sont utilisés ;
`checkout.astro` porte le même symptôme sur un symbole antérieur à ce jalon.

Vérification locale : `npm run verify` complet, la porte D1 comprise, qui rejoue
le brouillon des CGV livré par la migration 0040, sa publication, le refus, le
non-mouvement de stock, l'acceptation, et le taux recopié sur la réservation.

### Jalon 4 — Import de catalogue

Durée indicative : 3 à 4 jours.

#### Livrables

- [x] format CSV contractuel ;
- [x] schéma et validateur ;
- [x] dry-run ;
- [x] upsert idempotent par SKU ;
- [x] import d'images ;
- [x] optimisation d'images — voir l'État, qui nomme ce qui est fait et ce qui
  est délégué ;
- [x] rapport d'import ;
- [x] catalogue témoin de vingt produits.

#### Tests

- [x] SKU manquant ;
- [x] SKU dupliqué ;
- [x] prix invalide ;
- [x] stock non entier ;
- [x] variante incohérente ;
- [x] catégorie inconnue ;
- [x] image absente ou trop lourde ;
- [x] faux type MIME ;
- [x] Markdown hostile ;
- [x] réimport sans doublon ;
- [x] mise à jour d'un produit ;
- [x] interruption et reprise ;
- [x] import de 100 produits.

#### Critère de sortie

- [x] Le catalogue peut être reconstruit intégralement à partir du CSV et des
  médias sources.

Vérifié, pas affirmé : `npm run test:catalog` applique les migrations du dépôt à
une base vide, y importe le catalogue témoin, et relit les vingt produits, leurs
neuf variantes, leurs quatre catégories et leurs huit médias. C'est la
reconstruction intégrale, exécutée à chaque commit.

#### État

Une décision porte tout le reste, et elle est figée par
l'[ADR 0012](architecture/decisions/0012-identite-du-catalogue-importe.md) :
**l'identité est la référence, et rien d'autre**. `products.sku` arrive avec la migration 0042 — les variantes en
avaient une depuis 0017, parce qu'une variante *est* l'unité d'inventaire ; un
produit simple n'avait nulle part où mettre la sienne. Le slug ne pouvait pas
tenir ce rôle : il bouge dès qu'on corrige un nom, et l'identifiant de ligne est
une invention de la boutique, absente du fichier que le commerçant maintient.

De cette décision découlent les deux propriétés que le plan demandait
séparément. **L'idempotence** n'est pas « réécrire les mêmes valeurs » mais
« n'avoir rien à écrire » : le second import du catalogue témoin produit un plan
vide — zéro instruction, zéro envoi — et le test l'affirme sur ce nombre-là.
**La reprise** ne tient aucun journal. Une exécution interrompue laisse un état
que la suivante lit, et le plan calculé depuis cet état *est* le reste à faire.
Le test coupe le premier import après quarante instructions et vérifie que la
reprise atterrit sur exactement le catalogue d'un import ininterrompu. Un
journal aurait eu besoin de survivre à l'interruption qu'il était censé décrire.

Les images suivent la même logique, déplacée dans le nommage : la clé R2 est
`media/<20 hex de sha256>.<ext>`. Deux produits qui partagent une photo
partagent un objet et une ligne `media` ; un réimport n'envoie rien, sans avoir à
interroger le bucket. La contrainte des vingt caractères n'est pas esthétique :
au-delà de 32 chiffres hexadécimaux, le pipeline d'observabilité de Cloudflare
biffe l'identifiant dans l'URL et chaque requête d'image se journalise en
`GET /images/media/REDACTED.webp` (voir `mediaKeyFor()`). L'admin garde ses clés
aléatoires : deux téléversements de la même photo y sont deux gestes délibérés,
là où deux exécutions d'un import sont le même geste.

**Le séparateur est déduit de l'en-tête.** Un tableur français exporte en `;`,
et pour une bonne raison : la virgule est le séparateur décimal, donc un export
en virgules demanderait de guillemeter chaque prix, et la première fois que l'un
ne l'est pas la ligne se décale d'une colonne sans que rien ne le signale. La
décision se prend sur la ligne d'en-tête seule, où elle est sans ambiguïté —
aucun nom de colonne du contrat ne contient l'un ou l'autre caractère.

**Rien n'est écrit tant que tout n'est pas jugé, et rien n'est supprimé.** Un
plan qui porte un refus ne porte aucune instruction : « à moitié importé » est
l'état que personne ne sait nommer. Une variante qui quitte le fichier est
désactivée et non effacée — `order_items.variant_id` la référence, et
l'historique n'appartient pas au catalogue. Les produits absents du fichier ne
sont pas touchés du tout : un CSV n'est pas tenu d'être le catalogue entier, et
importer la gamme d'un fournisseur ne doit pas retirer celle d'un autre. Les
trois pertes possibles demandent chacune leur option : `--allow-slug-change`
(une URL publique retirée doit laisser une redirection derrière elle,
invariant 9), `--allow-remove-variants`, `--create-categories`.

**Le fichier SQL est la surface de sécurité.** Un import de deux cents produits
fait deux mille instructions, et payer un démarrage de processus par instruction
transforme trente secondes en une demi-heure : l'applicateur passe donc un
`wrangler d1 execute --file` unique, ce qui interdit les paramètres liés et
inline chaque valeur. `catalog/sql.mjs` est écrit pour être ennuyeux — guillemet
simple doublé, octet NUL refusé — et la porte écrit
`'); DROP TABLE products;--` dans une vraie base pour le relire tel quel.

La porte de test ne simule pas la base. `node:sqlite` applique les migrations du
dépôt, puis les instructions que le planificateur a produites : ce qui est
vérifié est le SQL livré, ses sous-requêtes, ses index et ses déclencheurs FTS.
Un faux magasin serait passé le jour où le vrai `INSERT` aurait violé une
contrainte. Le module est lancé dans un processus enfant parce que `node:sqlite`
demande `--experimental-sqlite` sur la moitié basse de la ligne Node certifiée.

Deux limites, nommées plutôt qu'implicites.

**L'optimisation d'images ne redimensionne pas.** Rien dans une CLI sans
dépendance ne réencode un JPEG, et la boutique n'en a pas besoin :
`features/products/image.ts` sert déjà chaque image du catalogue en quatre
largeurs via `fit=scale-down,format=auto`. Ce que l'import doit au commerçant est
donc le contrôle et l'avertissement — type réel lu dans les octets, SVG refusé
parce qu'il s'exécuterait sur le domaine de la boutique, budget de 5 Mo identique
à celui du téléversement admin, dimensions enregistrées, source au-delà de
2048 px signalée — et non un réencodage silencieux qui changerait les octets dont
la clé est dérivée. Une source trop grande coûte du stockage et la première
transformation, pas de la bande passante à chaque page vue.

**`product_variants.sku` n'a pas d'index unique.** La colonne est du texte libre
dans l'admin depuis 0017, donc une boutique peut déjà porter des doublons, et
une migration qui échoue sur les données d'une boutique est une migration qu'on
ne peut pas livrer à une flotte. L'import refuse une référence ambiguë au moment
du plan, en nommant les deux lignes — ce qu'un index ne saurait pas faire.

Deux règles pures existent en double exemplaire, délibérément : `slugify()` et
la lecture des dimensions dans l'en-tête d'une image. L'une vit dans le bundle
du Worker, l'autre dans une CLI sans étape de build. Les deux paires sont
épinglées l'une à l'autre sur un corpus partagé, pour qu'une divergence fasse
échouer une porte au lieu de produire deux URL pour un même nom.

### Jalon 5 — Thème du pilote

Durée indicative : 4 à 6 jours.

#### Livrables

- [x] design tokens ;
- [x] header et navigation ;
- [x] footer ;
- [x] catalogue ;
- [x] cartes produits ;
- [x] fiche produit ;
- [x] pages de contenu ;
- [x] responsive ;
- [x] états vides, longs, épuisés et en erreur.

#### Tests

- [x] `npm run theme:check` sur le thème du pilote ;
- [x] `npm run test:storefront-contract` sur le thème du pilote ;
- [x] `npm run verify` sur le thème du pilote.

Les trois passent sans qu'aucun fichier de CI ait été modifié : les jobs
« Verify theme » et « Build shop » découvrent les thèmes et les boutiques dans
l'arbre plutôt que dans une liste, donc `atelier` a rejoint la matrice le jour
où le répertoire a existé. C'est la propriété que le jalon 1 avait achetée et
que celui-ci encaisse.

Ajouter :

- [x] Playwright desktop et mobile ;
- [x] régression visuelle ;
- [x] axe ;
- [x] navigation clavier ;
- [x] zoom 200 % ;
- [x] navigation sans JavaScript ;
- [x] ajout au panier avec et sans JavaScript ;
- [x] titres très longs ;
- [x] catalogue vide ;
- [x] produit épuisé ;
- [x] erreur de recherche.

Tout est porté par `npm run test:browser` — Playwright contre le Worker
**construit**, sur une D1 isolée semée par les mêmes fixtures que les lignes de
base HTML. 84 tests, deux projets (bureau et téléphone), un job de CI par thème.
Les quatre designs le passent, parce que ce que la suite affirme sont des
contrats du storefront et non des préférences du pilote.

Ce qui n'est PAS gaté, et pourquoi : la barre des 320 px CSS de WCAG 1.4.10
(400 % de zoom sur un écran de 1280, ou un iPhone SE). `atelier` la tient ;
`default` la manque de 37 px, et arbitrer lequel de son menu, de son lien de
recherche ou de son panier cède la place à cette largeur est une décision de
design qui appartient au propriétaire de ce thème, pas à un test. Une porte que
le thème livré ne peut pas passer serait désactivée en une semaine.

#### Critère de sortie

- [x] Le storefront est visuellement spécifique et tous les contrats fonctionnels
  Minshop restent verts.

#### État

**Le thème du pilote appartient au marchand, et c'est le fait structurant.**
`src/themes/atelier/` ne porte aucun identifiant réservé, donc
`scripts/path-ownership.mjs` le classe côté `client` : le cœur n'y touchera
jamais et une montée de version ne peut pas y produire de conflit (ADR 0003).
Les deux boutiques témoins cessent du même coup d'être symétriques, ce qui est
un gain : `canary-minimal` continue de sélectionner un thème livré par le socle,
`pilot-fr` sélectionne un design que le cœur ne possède pas. La paire vérifie
maintenant deux propriétés au lieu d'une.

**Rien n'a été ajouté à la CI.** Le job « Verify theme » interroge
`discoverThemeIds()` et le job « Build shop » interroge `prepare-client --list` ;
les deux ont donc pris `atelier` en charge sans qu'une liste soit éditée. Un
thème que le socle ne connaît pas passe exactement les mêmes portes que les
siens : contrat storefront, `astro check`, frontière de présentation, build,
CSS compilé.

**Le catalogue de messages est propriété du cœur, et un thème client ne peut
donc pas y écrire sa copie.** Les trois thèmes livrés ont chacun leur clé
`catalog.empty.<thème>` ; `atelier` n'en prend pas et lit
`catalog.empty.default`. Ce n'est pas un pis-aller : une clé nommée d'après un
client dans un fichier du cœur serait précisément la condition que
`config:validate` existe pour interdire. La formulation qui doit appartenir au
marchand a déjà un endroit où vivre — l'annonce, les pages, les noms de
catégories — et cet endroit est l'administration, pas un fichier source.

**Deux bogues du socle français sont sortis de l'exercice**, tous deux
invisibles pour les portes existantes parce que toutes les portes existantes
lisent du HTML sans jamais exécuter de script :

- le script de prix vivant de `/products/[slug]` construisait
  `new Intl.NumberFormat('en-US', …)`. Le serveur rendait `24,00 €` et le
  navigateur le réécrivait en `€24.00` dès qu'un produit avait une variante ou
  une option. Les lignes de base storefront sont capturées avec `curl`, donc
  aucun script ne s'y exécute ; les contrats de conteneur rendent du balisage à
  partir de props et n'en exécutent pas davantage. Il a fallu ouvrir la page.
  `Layout.astro` publie désormais `<html lang="fr" data-locale="fr-FR">` — la
  sous-étiquette de langue pour HTML, l'étiquette complète pour `Intl`, les deux
  tirées de la même constante — et le script la lit là. `define:vars` aurait
  marché aussi, mais impose `is:inline` : un script non minifié, commentaires
  compris, sur la page la plus visitée de la boutique. Mesuré sur une fiche
  produit : +354 octets gzip pour cette voie contre +21 pour l'attribut, à
  correction identique ;
- `/admin/media` et `/admin/pages` construisaient chacun leur propre
  `Intl.DateTimeFormat('en-US')` et formataient en UTC, donc ces deux écrans
  contredisaient les listes Commandes et Clients d'à côté sur la forme de la
  date ET sur le jour affiché. Les deux passent maintenant par le `formatDate`
  partagé et le fuseau de la boutique, comme le reste de l'administration
  (ADR 0011 garde l'admin en anglais ; les dates et les montants, eux, suivent
  la boutique).

`test/storefront/locale-source.test.mjs` est la porte qui manquait :
`src/features/i18n/locale.ts`, `format.ts` et `money.ts` sont les seuls modules
autorisés à nommer une langue, et tout autre `new Intl.X('…')` fait échouer la
suite. Elle a été vérifiée dans les deux sens — remise en place, l'ancienne
ligne la fait tomber.

### La porte navigateur

Une inspection n'est pas une porte, donc les mesures faites à la main pendant ce
jalon sont devenues `npm run test:browser` : Playwright contre le Worker
**construit**, sur une D1 isolée semée par `test/fixtures/storefront-states.sql`
— la même fixture que les lignes de base HTML, pour qu'un état vérifié ici soit
un état qu'on peut ouvrir dans un navigateur et regarder.

Elle n'est pas dans `npm run verify`, et c'est délibéré plutôt que budgétaire :
`verify` est la porte qu'une boutique passe sur un portable et dans le chemin de
déploiement, et elle ne doit pas avoir besoin de télécharger 150 Mo de Chromium
pour répondre. La CI lui donne un job par thème.

**Ce qu'elle attrape, personne d'autre ne le voyait.** Les contrats de conteneur
rendent un composant à partir de props : aucune feuille de style n'est
appliquée, aucun script client ne s'exécute, rien n'a de largeur. C'est la bonne
forme pour un contrat de présentation et c'est structurellement aveugle à toute
une classe de défauts. Quatre sont sortis dès la première exécution, tous dans
le **cœur** et donc dans les quatre thèmes :

- `ProductGallery` donnait à ses vignettes des liens **sans nom accessible**.
  Un lecteur d'écran annonçait une rangée de « lien » anonymes. Le nom est
  maintenant positionnel — « Image 2 sur 4 » — plutôt que le nom du produit, qui
  aurait étiqueté les quatre à l'identique ;
- la piste de la galerie **défile sans pouvoir prendre le focus**. Au clavier,
  les images après la première n'existaient tout simplement pas ;
- `/categories/<slug>` affichait `No products in this category yet.` — la
  dernière phrase anglaise du storefront — et surtout l'affichait **sans
  `role="status"`**, alors que le catalogue, lui, doit annoncer son état vide
  sur chaque thème. Une catégorie vide devenait une page blanche muette ;
- les trois thèmes livrés **épinglaient leur nom de boutique** à sa largeur
  naturelle (`shrink-0`). « Ma boutique » tient partout ; « Atelier de céramique
  de Haute-Provence » poussait le panier hors de l'écran à 390 px. Le
  rétrécissement flex étant proportionnel, il a fallu les deux moitiés du
  correctif : le nom rétrécit (`min-w-0 truncate`), les commandes non
  (`shrink-0`), sinon le `<nav>` absorbe une part qu'il ne sait pas rendre.

**La régression visuelle n'est pas une comparaison de pixels**, et c'est le
choix de conception de cette suite. Une capture PNG n'a de sens que contre le
moteur de rendu qui l'a enregistrée — hinting, positionnement sous-pixel,
rastérisation GPU diffèrent entre un portable et un runner —, donc il lui faut
un conteneur épinglé ou elle signale des échecs que personne n'a causés. Ce
dépôt dépense déjà un workflow entier à mesurer un aléa
(`.github/workflows/d1-flake-probe.yml`) ; en ajouter un second, auto-infligé,
serait un mauvais échange. Ce qui régresse vraiment dans un design piloté par
des jetons, c'est un jeton — et cela se lit dans le style **calculé**. La suite
enregistre donc dix sondes par thème (`test/browser/__signatures__/`). Vérifié :
changer `--color-paper` d'un seul chiffre hexadécimal fait tomber la porte.

« Le style calculé est identique sur toutes les machines » était vrai à moitié,
et la CI l'a dit tout de suite : `default` et `atelier` sont rouges au premier
passage, `studio` et `market` verts. C'est exact pour `rgb(...)`, faux pour les
formes à large gamut — un modificateur d'alpha comme `bg-paper/85` est compilé
par Tailwind en `color-mix(in oklab, …)`, et la valeur calculée revient en
`oklab()` avec une précision flottante propre à l'implémentation. D'où
`oklab(0.96524 …)` ici et `oklab(0.965308 …)` sur le runner, sur les deux seuls
thèmes dont l'en-tête porte un fond translucide. Un écart de 5e-5 en clarté
oklab vaut un centième de pas sur 8 bits : aucun écran ne peut le montrer, donc
ce n'est pas une régression visuelle. Les couleurs passent maintenant par un
canevas 1×1 — le convertisseur du navigateur lui-même — et sont enregistrées en
octets sRGB, ce qui rend la sonde exacte au lieu de la rendre tolérante.

**Ce qui n'est pas gaté** est nommé plutôt qu'omis : la barre des 320 px CSS de
WCAG 1.4.10. `atelier` la tient, `default` la manque de 37 px — son `<nav>` porte
un menu replié, un lien de recherche et le panier, et aucun des trois ne peut
céder. Choisir lequel cède est une décision de design qui appartient au
propriétaire de ce thème. Le plan demandait 200 % ; c'est 200 % qui est gaté.

Le même passage a sorti un aléa de la suite elle-même, sur `atelier` seul et
sur les deux projets : le clic sans JavaScript visait un bouton encore en
mouvement. Le bloc « sans JavaScript » était le seul à ne pas attendre que la
page se stabilise, et il attendait `domcontentloaded` là où les images comptent
— sur un lien rapide elles étaient déjà là, sur le runner elles arrivaient après
et décalaient le formulaire sous le pointeur. Reproduit en bridant le réseau à
30 ko/s, corrigé en attendant `load`, puis revérifié sous le même bridage.

Deux notes d'outillage. Chromium vient de `npx playwright install chromium` ;
sur une machine qui en a déjà un et ne peut pas en télécharger un autre,
`test/browser/chromium.mjs` se rabat sur ce qu'il trouve et le dit à voix haute
plutôt que de résoudre en silence. Et la visibilité du focus est affirmée comme
une **différence** entre les styles calculés focalisé et non focalisé, pas comme
« a un contour » : un thème qui allume l'entourage de son champ de recherche via
`focus-within:` est parfaitement valable et échouerait une liste de propriétés
autorisées.

### Jalon 6 — Provisioning et CI/CD

Durée indicative : 4 à 5 jours.

#### Livrables

- [x] `shopctl provision` ;
- [x] staging et production ;
- [x] D1 et R2 EU ;
- [x] secrets internes ;
- [x] GitHub Environments ;
- [x] approbation production ;
- [x] dépôt, environnements et secrets créés par la CLI (§5.2 bis, ADR 0014) ;
- [x] preview privée de staging et suppression d'un environnement (ADR 0015) ;
- [x] domaine personnalisé ;
- [x] domaine d'images ;
- [x] bucket privé non public ;
- [x] smoke tests post-déploiement.

#### Tests

- [x] dry-run ;
- [ ] provisioning dans un compte de test ;
- [x] seconde exécution sans changement ;
- [x] reprise après interruption ;
- [x] mauvais compte Cloudflare refusé ;
- [x] juridiction EU vérifiée via API ;
- [x] bucket privé inaccessible publiquement ;
- [x] déploiement CI ;
- [x] smoke test automatique.

Tout est porté par `test/scripts/provision.test.mjs` et
`test/scripts/deploy.test.mjs`, contre une **doublure de wrangler** —
`test/fixtures/wrangler-double.mjs` — qui répond comme le vrai à partir d'un
compte tenu dans un fichier JSON. Le vrai binaire de la boutique est remplacé à
l'endroit exact où il vivrait, `node_modules/.bin/wrangler`, si bien que le
chemin exercé est le chemin réel : la construction des arguments, l'analyse des
sorties, les codes de sortie. Seul le compte est imaginaire.

`provisioning dans un compte de test` reste ouvert et le restera jusqu'à ce
qu'un compte Cloudflare de test existe : c'est la seule ligne de cette liste que
le dépôt ne peut pas trancher tout seul. Ce que la doublure prouve, elle le
prouve pour de bon — la juridiction demandée à la création, le second passage
qui ne crée rien, la reprise après interruption, le secret qui n'apparaît jamais
dans un vecteur d'arguments. Ce qu'elle ne peut pas prouver est nommé plus bas.

#### Critère de sortie

- [x] Une boutique créée par la CLI peut être déployée en staging avec une
  commande, hors autorisations humaines initiales.

#### État

**Un environnement qualifie la souche du nom, pas une ressource.**
`minshop-<slug>-<env>` puis `-db`, `-images`, `-files`, `-session` (plan §5.3,
[ADR 0013](architecture/decisions/0013-environnements-de-deploiement.md)). Une
boutique reste **une seule famille de noms** : `destroy-cf.sh` continue de la
retirer d'un coup, et une liste de compte garde les ressources d'une boutique
voisines. La famille non qualifiée subsiste, et ce n'est pas un troisième
environnement : c'est celle des builds témoins, de la porte navigateur et du
développement local, dont aucun ne joint un compte.

**`config:validate` revendique maintenant les noms des deux environnements**, et
cela a attrapé une collision que la convention créait toute seule : une boutique
nommée `ceramique-staging` dérive exactement la base de staging de la boutique
nommée `ceramique`. Deux clients, un jeu de commandes, et rien à l'exécution
pour les séparer (ADR 0001). Le suffixe n'est un espace de noms que si rien
d'autre ne peut y atterrir.

**Le bug qui n'aurait produit aucune erreur : la juridiction sur le binding.**
Un bucket créé avec `--jurisdiction eu` vit dans un espace de noms qu'un binding
sans juridiction ne voit pas. Le déploiement **réussit** ; le Worker démarre
avec un bucket qui répond comme s'il était vide. Aucune exception, aucun log,
des images manquantes. `wrangler.template.jsonc` répète donc la juridiction sur
chaque binding R2, remplie depuis le manifeste comme le reste.

**Le provisioning n'a pas de fichier d'état, et c'est ce qui le rend
rejouable.** Chaque étape interroge le compte — `d1 list`, `r2 bucket list`,
`secret list` — puis décide. Un fichier dirait ce qu'une exécution précédente a
cru ; le compte dit ce qui existe. Il n'y a donc ni `--resume`, ni mode
particulier : une exécution tuée entre la base et les buckets reprend en posant
les mêmes questions et en trouvant une réponse de plus.

**`SECRETS_KEK` n'est jamais renouvelé par une seconde exécution.** Il chiffre
les clés de paiement que le commerçant a collées dans Admin → Réglages : en
générer un nouveau les rendrait toutes indéchiffrables, et la boutique cesserait
d'encaisser sans qu'aucun message ne le dise. Un secret déjà présent est donc
**conservé**, jamais réécrit.

**Les secrets ne peuvent pas être posés avant le premier déploiement**, parce
que `wrangler secret put` n'a pas de Worker auquel les attacher. Le provisioning
les annonce en attente plutôt que d'échouer, `shopctl deploy` les pose, et un
`shopctl provision` ultérieur les constate. C'est la seule couture du jalon, et
elle est décrite dans les deux rapports plutôt que devinée.

**La juridiction est relue, jamais supposée.** Pour R2 le contrôle est à deux
faces : présent en juridiction `eu` ET absent de la juridiction par défaut — la
seconde moitié attrape la forme qu'une reprise ratée produit, deux buckets de
même nom dans deux juridictions, dont le binding en choisira un que personne ne
saura nommer. Pour D1, l'API ne publie pas toujours le champ en retour ; le
rapport dit alors **« non vérifié »** au lieu de dire « conforme ». Un contrôle
qui répond « ok » sur une absence est pire que pas de contrôle.

**Le test de fumée peut faire échouer le déploiement**, et il traite une requête
qui n'aboutit pas comme un échec, jamais comme un succès. Ce qu'il affirme est
petit et choisi : que la vitrine se déclare `lang="fr"` (une page d'accueil
vide, ou celle d'une autre boutique, répond 200 exactement pareil), que
`/products` rend — donc que la liaison D1 répond —, et que `/admin` ne répond
pas 200 sans authentification. L'assistant de première installation, lui, est
un **avertissement** et non un échec : il est censé être joignable sur une
boutique qui n'a pas encore de mot de passe, et une porte qui échoue à chaque
premier déploiement porterait un `--skip` en une semaine.

**Le domaine personnalisé et `workers.dev` sont une seule décision.** La
production rend sa route en domaine personnalisé et ferme `workers_dev` au même
moment ; staging garde `workers.dev`, qui est le seul moyen de l'atteindre.
Deux portes vers la même boutique, c'est une origine que le commerçant n'a
jamais annoncée, indexée par les moteurs et hors de tout Cloudflare Access posé
sur le vrai nom d'hôte.

**Deux champs facultatifs sont apparus au manifeste** — `cloudflare.accountId`
et `cloudflare.imagesDomain` — et le mécanisme qui les rend facultatifs est
nouveau : jusqu'ici, tout champ était requis. La distinction tient : un champ
qu'une boutique **décide** reste requis, parce qu'un champ manquant est une
décision que personne n'a prise ; ces deux-là, la boutique les **apprend** —
l'un n'existe qu'une fois le provisioning passé, l'autre seulement si un domaine
a été attaché. Les exiger imposerait un cabochon qui valide et ne veut rien
dire. `test/scripts/manifest.test.mjs` épingle la liste par son nom : un
troisième champ facultatif sera un acte délibéré.

**Ce qui n'est PAS gaté, et pourquoi.** Trois choses, nommées plutôt qu'omises :

- **le provisioning contre un vrai compte.** La doublure répond aux formes que
  wrangler produit ; elle ne prouve pas que Cloudflare accepte la requête. La
  première exécution réelle reste devant nous, et c'est la ligne non cochée
  ci-dessus ;
- **la délégation du domaine.** `shopctl doctor` la nomme depuis le jalon 2 dans
  la liste humaine. Un déploiement de production sur un domaine non délégué
  échoue bruyamment — `workers_dev` étant fermé — ce qui est le bon échec, mais
  ce n'est pas une vérification ;
- **les GitHub Environments eux-mêmes.** `shopctl repo` les crée et y pose les
  secrets, mais que `production` porte bien des relecteurs obligatoires dépend
  du plan GitHub du compte : les règles de protection sont payantes sur un dépôt
  privé. La commande le tente et le rapporte ; ce qu'elle ne peut pas faire,
  elle ne le simule pas. `test/scripts/deploy.test.mjs` épingle ce
  que le fichier peut porter — l'attachement à l'environnement, le passage par
  les commandes de la CLI plutôt que par des appels wrangler propres au
  pipeline, `pipefail` sur les étapes qui passent le rapport dans `tee`, et
  qu'aucune entrée de dispatch n'est interpolée dans une source shell.

**La forge est automatisée, et c'est une contrainte cryptographique qui a
décidé de la forme.** Créer une boutique demandait neuf gestes, dont six clics
dans GitHub : le dépôt, la poussée, deux environnements, quatre secrets, les
relecteurs. `shopctl repo` fait les quatre premiers et tente le cinquième, de
façon rejouable, et `shopctl new --create-repo` l'enchaîne après le premier
commit. Une nouvelle boutique tient maintenant en trois commandes.

La forme — envelopper `gh` plutôt que parler à l'API — n'est pas une
préférence. Un secret d'environnement GitHub se chiffre en sealed box
libsodium : X25519, Blake2b, **XSalsa20-Poly1305**. Node 22 fournit les deux
premiers et pas le troisième, vérifié plutôt que supposé. Une CLI qui ne peut
avoir aucune dépendance — `shopctl new` tourne avant qu'il n'existe un
`node_modules` — ne peut donc pas chiffrer un secret pour GitHub du tout
(ADR 0014).

Trois décisions valent d'être connues. Le dépôt est **privé** par défaut, et un
dépôt existant n'est jamais repassé en privé : la visibilité est signalée, pas
corrigée, parce que refermer un dépôt ne défait pas les clones déjà faits. Un
secret déjà présent est **réécrit**, à l'inverse exact de la règle Cloudflare :
GitHub ne renvoie jamais la valeur d'un secret, donc « déjà là » ne peut pas se
lire « déjà correct » — ce pourrait être le jeton du mois dernier. Et les règles
de protection sont **tentées, jamais supposées** : sur un dépôt privé hors
GitHub Pro, l'API refuse les relecteurs et accepte l'environnement ; la commande
garde l'environnement, qui porte les secrets, et dit que l'approbation n'est pas
opposable au lieu de laisser croire qu'elle l'est.

**Le cycle de vie a été fixé, et il déplace une frontière.** Quatre étapes —
construction, preview privée, saisie par le client, mise en ligne — et le compte
Cloudflare du client devient le prérequis de la **troisième**, pas de la
quatrième ([ADR 0015](architecture/decisions/0015-cycle-de-vie-d-une-boutique.md)).
La raison est mesurable : Cloudflare ne transfère rien entre comptes, donc le
seul moment où des données existent doit déjà se passer sur le compte définitif.
Placer la frontière à la mise en ligne aurait rendu `shopctl backup`/`restore`
— jalon 9 — obligatoire avant toute livraison.

Deux constats du code ont décidé de la preview. Une application Cloudflare
Access **se lie à un nom d'hôte**, et `src/middleware.ts` explique pourquoi il
vérifie la signature du JWT plutôt que de faire confiance à l'en-tête : celui-ci
est falsifiable contre une origine `*.workers.dev`. Une preview privée exige
donc un nom d'hôte **et** `workers.dev` fermé, et déclarer
`cloudflare.stagingDomain` fait maintenant les deux d'un coup — ce sont les deux
moitiés d'une seule décision, pas deux réglages. Et `isProtected()` ne couvre
que `/admin` : fermer une preview est une affaire de bordure, pas de code, donc
le cœur n'a pas bougé.

Le test de fumée pose alors la **question inverse** sur un environnement déclaré
privé : une réponse 200 à une requête non authentifiée le fait échouer. C'est la
panne qui ressemble à un succès — une URL de preview envoyée au client, qu'un
moteur de recherche trouve aussi, servant une boutique qui n'a pas ouvert.

**`shopctl destroy` ferme le cycle**, et son irréversibilité dessine tout le
reste : il demande le slug **saisi** plutôt qu'un `--yes` qui devient un réflexe
dès la troisième fois, exige `--yes` en plus en production, lit avant d'écrire,
supprime la base **en dernier** et seulement si le reste est parti — une
exécution interrompue laisse une base lisible plutôt que des buckets que plus
rien n'interprète — et ne vide jamais un bucket : R2 refuse d'en supprimer un
non vide, et ce refus est relayé tel quel.

**Un bug est sorti de la doublure `gh`**, et il n'aurait été vu sur aucune
machine de développement ordinaire : `git remote get-url origin` applique les
réécritures locales `url.<base>.insteadOf` — courantes en entreprise et derrière
un miroir. shopctl lisait donc l'URL réécrite comme identité du dépôt et aurait
créé un dépôt GitHub nommé d'après ce que la réécriture pointe. Il lit
maintenant `git config --get remote.origin.url`, la valeur configurée.

**Deux corrections d'outillage sont sorties de l'exercice.** `npx --no-install
wrangler` coûte environ une demi-seconde de résolution avant que wrangler
démarre ; un provisioning en fait une quinzaine, un import de catalogue une par
image. Toutes les invocations passent maintenant par un seul point qui appelle
directement `node_modules/.bin/wrangler` quand il est là — la suite de
provisioning est passée de 122 à 20 secondes, et c'est la même seconde que
l'exploitant ne paie plus. Et `main()` est devenue asynchrone : une seule
commande en a besoin — `deploy` finit par une requête réseau — et l'alternative
essayée d'abord était pire, un sous-processus pour drainer une promesse afin que
les cinq autres gardent une signature qu'aucune n'utilisait.

### Jalon 7 — Paiement et traitement de commande

Durée indicative : 4 à 5 jours.

#### Livrables

- [ ] Stripe test et live ;
- [x] webhook signé ;
- [x] livraison France ;
- [x] promotions ;
- [x] comportement TVA retenu ;
- [x] Resend ;
- [x] confirmation de commande ;
- [ ] notification d'expédition ;
- [x] remboursement.

#### Tests

- [x] paiement réussi ;
- [x] paiement refusé ;
- [x] paiement asynchrone réussi et échoué ;
- [x] session expirée ;
- [x] webhook dupliqué ;
- [x] webhook désordonné ;
- [x] signature invalide ;
- [x] remboursement total ;
- [x] remboursement partiel ;
- [x] Resend indisponible ;
- [x] achat concurrent de la dernière unité ;
- [x] prix changé depuis l'ajout au panier ;
- [x] stock changé ;
- [x] franco au seuil exact ;
- [x] promotion invalide ou expirée.

#### Critère de sortie

- [ ] Un paiement réel de faible montant peut être encaissé puis remboursé avec
  cohérence entre Stripe, D1, stock, admin et e-mails.

#### État

**Tout existait, rien n'était prouvé.** Le règlement — la vérification de
signature, la normalisation de l'événement, l'écriture de la commande, le stock,
les remboursements, les e-mails — était écrit depuis longtemps et couvert nulle
part : aucun test n'avait jamais construit un événement Stripe, aucun n'avait
vérifié une signature, et `recordPaidWebhookOrder` — la fonction qui décide si
de l'argent devient une commande — n'avait jamais été appelée par un test. Les
suites voisines éprouvent les pièces qu'elle orchestre (réservations,
comptabilité des remboursements, machine à états de l'outbox) isolément ; c'est
l'orchestration qui manquait, et c'est là que les livraisons dupliquées,
tardives et désordonnées font leurs dégâts. Le jalon 7 est un jalon de
certification, pas de construction : le trou était dans la porte, pas dans le
code. `test/integration/settlement.mjs` (quinze scénarios) et
`src/features/payments/stripeWebhook.test.ts` (vingt et un) le referment.

**La suite parle à la vraie fonction, pas à une copie.** `recordWebhook.ts`
importe `cloudflare:workers` à la première ligne, et tout ce qu'il délègue aussi
— la fabrique de paiement, celle d'e-mail, le notificateur de remboursement.
Deux issues existaient. Réécrire cette chaîne pour qu'elle reçoive `db` en
paramètre : une modification du code de production faite pour un test, sur le
seul chemin où une erreur coûte l'argent d'un client. Ou injecter la liaison :
`test/helpers/workers-loader.mjs` résout `cloudflare:workers` vers un module que
la suite remplit d'une vraie base Miniflare. C'est la seconde, et le code
exécuté est **octet pour octet** le code déployé. Le crochet fait aussi ce que
Vite fait pour tous les autres consommateurs de ces fichiers — résoudre `./db`
sans extension —, et seulement après un échec de Node, jamais à sa place.

**Le schéma est le vrai.** Les autres scripts d'intégration écrivent à la main
les quelques tables qu'ils touchent. Le règlement, lui, n'est pas isolé : il
écrit les commandes, les lignes, le registre d'identités et ses déclencheurs, le
stock sur deux tables, les réservations, les exceptions d'inventaire, l'outbox,
les remboursements et leurs événements, et lit les réglages et l'accès invité au
passage. Un sous-ensemble écrit à la main, c'est un second schéma à tenir à jour,
et la dérive est silencieuse : une colonne que la suite a oubliée est une colonne
que la suite ne peut pas voir mal tourner. `test/helpers/d1-schema.mjs` applique
donc les 43 migrations réelles, 159 instructions, à chaque exécution. Son
découpeur ne réanalyse pas SQL : il s'appuie sur la règle que
`migrations-remote-safe.test.mjs` impose déjà — un corps de déclencheur ne
contient jamais un second `END;` — qui est exactement la règle du découpeur
distant de wrangler.

**Le seul défaut trouvé : une expiration enregistrée comme un refus.** Le cycle
de vie d'une réservation distingue `expired` de `failed`, et
`markInventoryReservationTerminal` prend le statut en paramètre pour cela. Son
unique appelant passait `'failed'`, toujours — si bien qu'un panier abandonné sur
la page hébergée de Stripe et une carte refusée laissaient la même ligne en base.
Rien ne bougeait côté argent, et c'est précisément pourquoi le défaut a survécu :
le règlement traite les deux pareil, seul l'exploitant qui relit la ligne
ensuite y perd quelque chose. `WebhookResult` porte maintenant un
`releaseReason`, l'adaptateur Stripe nomme la raison que Stripe lui donne, et un
adaptateur qui ne sait pas distinguer ne dit rien et retombe sur `'failed'` — la
valeur conservatrice. Le cœur reste ignorant du fournisseur (invariant 4).

**Ce que « paiement refusé » veut dire sur une page hébergée.** Une carte refusée
n'atteint jamais la boutique : Stripe la refuse sur sa propre page et l'acheteur
recommence. Ce que la boutique apprend, c'est la fin de la tentative — un débit
différé qui échoue (`async_payment_failed`) ou la session qui expire — et ce sont
ces deux événements que la suite éprouve. Il n'y a pas de troisième forme à
tester, et un test « carte refusée » qui inventerait un événement testerait une
fiction.

**Un remboursement se réconcilie en absolu, et le rejeu le prouve.** Stripe
publie le **cumul** remboursé d'une charge, jamais un delta. La suite rembourse
15 € sur 50 €, puis la totalité, puis **redélivre le premier événement** : le
total ne recule pas, aucune troisième ligne n'apparaît, et les deux lignes du
registre portent 15 € et 35 € — leurs propres deltas, pas le cumul. Un événement
qu'aucune commande ne réclame est mis en file de réconciliation plutôt que perdu,
même quand la corrélation auprès du fournisseur ne rend rien.

**Une panne d'e-mail ne coûte pas la commande.** Resend répondant 503, la
commande est écrite, les deux lignes d'outbox restent `pending` avec une
tentative et l'erreur, et un appel ultérieur les termine sans qu'un second
webhook soit nécessaire. Sans fournisseur configuré du tout, les lignes sont
`skipped` : une boutique sans e-mail n'est pas une boutique en échec.

**Ce qui n'est PAS gaté, et pourquoi.** Quatre choses, nommées plutôt qu'omises :

- **un paiement réel sur un vrai compte Stripe.** La doublure produit les formes
  que Stripe produit et signe comme Stripe signe ; elle ne prouve pas que le
  compte accepte la session. C'est la ligne non cochée du critère de sortie, et
  elle rejoint celle du jalon 6 : les deux attendent le même premier passage
  réel ;
- **« Stripe test et live ».** Le couple de clés est une configuration du
  coffre, pas du code : l'adaptateur ne sait pas laquelle il tient, et c'est
  voulu ;
- **la notification d'expédition.** Elle est mise en file à la fulfillment, pas
  au règlement — un autre déclencheur, que ce jalon n'a pas touché ;
- **une promotion invalide ou expirée.** Le refus arrive sur la page de Stripe et
  la boutique ne le voit jamais. Ce que le dépôt peut prouver, il le prouve : un
  code refusé ne laisse aucune remise sur la commande, un code accepté y dépose
  exactement son montant, et une remise de 100 % règle en
  `no_payment_required` sans intention de paiement.

**Une observation laissée en l'état.** `verifyWebhook` sait relire un instantané
de panier dans `session.metadata.items` ; l'adaptateur Stripe n'en écrit jamais —
`orderItemsJson` ne sert qu'aux rails auto-rendus, qui le gardent dans
`pending_payments`. La branche est donc morte pour Stripe. Elle n'est pas
supprimée ici : elle est inoffensive, et son retrait appartient à une revue de
l'ensemble du port plutôt qu'à un jalon de certification.

### Jalon 8 — Sécurité et exploitation

Durée indicative : 5 à 6 jours.

#### Livrables

- [x] Cloudflare Access ;
- [x] Turnstile ;
- [x] rate limits ;
- [x] en-têtes de sécurité ;
- [x] logs sans PII ;
- [ ] supervision ;
- [x] exports — `shopctl privacy export`, l'accès et la portabilité (RGPD
  articles 15 et 20) ;
- [x] politique de conservation ;
- [x] sauvegarde et restauration ;
- [ ] runbooks d'incident.

#### Tests

- [x] admin anonyme refusé ;
- [x] API admin anonyme refusée ;
- [x] CSRF ;
- [x] expiration de session ;
- [x] brute force ;
- [x] téléchargement non autorisé ;
- [x] upload SVG ;
- [x] faux MIME ;
- [x] traversée de chemin ;
- [x] absence de secrets dans logs et artefacts ;
- [x] absence d'adresse et d'e-mail dans les logs ;
- [x] restauration complète en staging ;
- [x] comparaison avant/après restauration ;
- [x] export et anonymisation d'un client — `test/scripts/privacy.test.mjs`
  exporte puis anonymise une personne dans une base issue des quarante-trois
  migrations, et constate que la commande d'une **autre** personne est intacte.

#### Critère de sortie

- [ ] La boutique peut être restaurée dans un nouvel environnement en moins
  d'une heure à partir d'une sauvegarde documentée. La procédure existe, elle
  est éprouvée de bout en bout contre le vrai schéma, et il lui manque le seul
  passage qu'aucun double ne remplace : un compte Cloudflare réel, chronométré.

#### État

Le jalon se coupe en deux moitiés qui ne partagent rien : **la porte**, qui est
du code déjà écrit et jamais éprouvé, et **l'exploitation** — sauvegarde,
restauration, conservation, export d'un client, supervision, runbooks —, qui
est du code à écrire. La première est faite ; la seconde l'est aux trois quarts.
Il lui reste la supervision, les runbooks d'incident, et le critère de sortie —
un chronomètre sur un compte réel.

**La porte existait ; personne ne l'avait poussée.** Le gate, la vérification
Access, la signature de session, le limiteur, la garde d'origine, les en-têtes :
tout était écrit, et chaque pièce avait son test unitaire. Aucun test n'avait
jamais posé la seule question qui compte — *le middleware les appelle-t-il, sur
les routes qui existent, dans l'ordre où il faut ?* — parce qu'aucun ne parlait
au Worker construit. `test/integration/security.mjs` le fait : trente-six
vérifications sur le bundle de production, la vraie base issue des 43
migrations, le vrai limiteur, le vrai routeur.

**Le harnais est Miniflare en processus, et c'est un choix, pas un raccourci.**
Les deux autres suites qui pilotent le Worker construit ouvrent une session
`wrangler dev` et lui parlent par un port. Celle-ci ne le pouvait pas, pour deux
raisons. La première est qu'elle déclenche le limiteur exprès, et que le proxy
de développement perd des connexions sous exactement ce genre de rafale — la
panne que `run-d1-integration.sh` existe pour rejouer. La seconde est qu'elle a
besoin de deux choses qu'un port ne donne pas : lire ce que le Worker imprime,
et répondre à sa place aux fournisseurs qu'il appelle. Sans la seconde, la
section sur les logs n'aurait rien prouvé.

**Les routes d'administration sont dérivées, pas listées.** Une liste écrite à
la main cesse d'être complète au premier endpoint ajouté, et l'endpoint que
personne n'a pensé à ajouter à la liste est précisément celui qui part sans
garde. La suite lit `src/pages/admin` et `src/pages/api/admin`, en déduit
trente-sept routes et leurs verbes depuis les `export const GET|POST|…`, et
exige de chacune un refus. Un fichier ajouté demain est couvert au prochain
passage, par quelqu'un qui n'aura pas eu à savoir que cette suite existe.

**Quatre défauts trouvés, tous réels, aucun théorique.**

- **L'adresse du client dans les logs de la boutique.** L'adaptateur Resend
  levait `Resend send failed (422): <corps>`, et le corps d'erreur de Resend est
  du texte libre où le fournisseur *cite le destinataire qu'il refuse*. Cette
  erreur est journalisée par l'outbox, par la notification d'expédition, par le
  lien magique et par l'avis de remboursement : une adresse mal saisie — le cas
  ordinaire — déposait le nom, la rue et le code postal de l'acheteur dans les
  Workers Logs, qui survivent à la commande. Deux couches de correction. Au
  point d'origine, l'adaptateur ne garde que le statut : c'est la moitié
  actionnable, et c'est la seule qui ne soit pas rédigée par un tiers. En
  défense, `features/observability/logSafe.ts` masque ce qui a une forme — les
  adresses e-mail, et les jetons d'accès invité, dont `redactAccessTokens` se
  disait « l'autorité de rédaction applicative » sans avoir un seul appelant en
  production. La suite le prouve dans le bon sens : en remettant le corps
  d'erreur, la rue, le nom et le code postal réapparaissent, l'adresse et le
  jeton non — les deux couches font bien deux travaux différents.
- **Une erreur non rattrapée ne passait par aucun contrat.** Tout ce que fait le
  middleware — la liste blanche de `cache-control`, les étiquettes de purge, les
  en-têtes — décrit les réponses qu'il *retourne*. Un `throw` n'en retourne
  aucune : Astro l'attrape plus loin et répond un 500 nu. C'était la seule
  classe de réponse à partir sans `no-store`, sur une plateforme dont le cache
  stocke les réponses sans en-tête, et sans le durcissement que porte tout le
  reste. Et il est atteignable sans authentification : un `POST` dont le
  `Content-Type` n'est ni l'un ni l'autre de ce que `formData()` sait lire
  suffit. Le `throw` est maintenant attrapé là où le reste du contrat
  s'applique.
- **La moitié statique de la boutique ne portait rien.** Le serveur d'assets de
  Cloudflare répond `/favicon.svg`, `/placeholder.*` et tout `/_astro/` *avant*
  le Worker : le middleware ne voit jamais ces requêtes, et elles partaient sans
  en-tête. `public/_headers` les couvre. Deux listes dans deux fichiers dérivent
  toujours, alors la liste vit désormais dans
  `src/features/http/securityHeaders.ts`, le middleware la lit, et
  `test/scripts/security-headers.test.mjs` relit `public/_headers` et refuse la
  différence. Le fichier est **core**, malgré son emplacement sous `public/` :
  c'est un contrôle de sécurité, pas un actif de marque.
- **Le type déclaré d'un téléversement venait du téléverseur.** `validateUpload`
  lisait `File.type`, que le client choisit :
  `-F 'files=@charge.svg;type=image/png'` est à un drapeau de distance. Rien ne
  s'exécute depuis un objet téléversé aujourd'hui — la bibliothèque refuse le
  SVG par son type, `/images` ressert ce que R2 a stocké, et `nosniff` est sur
  toute réponse —, donc ce n'était pas une entrée. C'était un fichier dont la
  boutique croyait quelque chose de faux, et toute couche ajoutée par-dessus en
  héritait. `features/media/sniff.ts` lit les seize premiers octets ; quatre
  comparaisons.

**Un cinquième point, laissé ouvert et nommé.** Il n'y a pas de
`Content-Security-Policy`. Les gabarits Astro portent des scripts et des styles
en ligne, et une CSP utile demanderait des nonces sur toute la chaîne de rendu :
c'est une modification du rendu, pas un durcissement d'en-tête, et elle
appartient à son propre passage plutôt qu'à celui-ci. (Étape 0 de la
certification : la part qui ne dépend d'aucun gabarit — `object-src`,
`base-uri`, `frame-ancestors` — est posée et gatée ; le reste est une
dérogation écrite, `docs/certification/plan.md` §6.) Le plancher
`referrer-policy` posé ici prend soin de ne jamais écraser le `no-referrer`
qu'une page à URL-capacité s'est donné — l'inverse aurait dégradé la seule
protection qui garde le jeton d'une commande hors des journaux d'un tiers.

**La suite de sécurité tourne déjà sur la boutique générée** en CI, au même
titre que sur le socle : c'est la campagne réutilisable du §1, et une boutique
nouvelle la passe le jour de sa création.

#### La seconde moitié : sauvegarde, restauration, conservation

**Les deux raccourcis évidents sont écartés, et c'est ce qui donne sa forme à
tout le reste.** Le Time Travel de D1 est un filet court terme dans un seul
compte : pas de R2, pas de conservation longue, aucune restauration vers un
autre compte — et c'est cette dernière qui décide, puisqu'elle est la condition
d'une sortie propre du client (ADR 0005, ADR 0002). Et `wrangler d1 export`
**échoue** sur une base portant des tables virtuelles FTS5, ce que celle-ci fait
depuis la migration 0003. La sauvegarde est donc applicative, table par table,
et le pipeline se coupe comme celui du catalogue : `schema`, `dump`, `crypto` et
`archive` sont purs, `store` est le seul fichier qui atteint wrangler — ce qui
fait de `--dry-run` le même chemin de code que la vraie prise, et non une
seconde implémentation de celle-ci.

**La liste des tables est déduite, jamais écrite.** `sqlite_master` dit ce que
la base contient. Une liste écrite dans un fichier source cesse d'être complète
à la première migration que personne n'y reporte, et la table absente de la
liste est la table absente de l'archive — silencieusement, jusqu'à une
restauration. C'est le raisonnement que la suite de sécurité applique aux routes
d'administration, appliqué à un schéma. Sont laissées de côté quatre familles,
chacune pour sa raison : `sqlite_*` et `_cf_*` appartiennent au moteur et à la
plateforme ; `d1_migrations` est le **schéma**, que la restauration obtient en
appliquant les migrations de l'arbre plutôt qu'en recopiant des lignes ; et
l'index FTS5 avec ses tables fantômes est un **index**, que les déclencheurs de
la migration 0003 reconstruisent au fur et à mesure que les lignes reviennent.
La suite le prouve dans le bon sens : après restauration, une recherche sur
`products_fts` rend le produit, depuis un index qu'aucune archive n'a porté.

**Une archive est un répertoire, pas un conteneur, et c'est la décision
structurante.** Un manifeste en clair, un corps chiffré, un fichier par objet
R2. Les deux promesses de l'ADR en découlent directement : une archive se
**contrôle sans être restaurée** — le manifeste porte la version du schéma, le
compte de lignes et l'empreinte de chaque table, et l'inventaire R2, si bien
qu'une agence qui tient cent archives n'en déchiffre pas cent pour trouver la
bonne — et elle se **relit sans Cloudflare**, donc dans un autre compte, sur un
autre fournisseur, sur un disque.

**Le manifeste en clair est authentifié avec le corps.** Ce qui est lisible sans
la clé est exactement ce qu'il devient intéressant de modifier, alors il est
passé à AES-GCM comme donnée additionnelle : une archive ne peut pas être
ré-étiquetée pour prétendre appartenir à une autre boutique, à un autre
environnement ou à un autre schéma — elle cesse simplement de s'ouvrir. Deux
champs restent hors de cette couverture parce qu'ils sont produits *par* le
scellement : `cipher`, et `data.digest`, qui est un contrôle de corruption pour
un lecteur sans clé et jamais une authentification. Le rapport de `verify` dit
lequel des deux niveaux il a atteint plutôt que de rendre un vert unique.

**L'inventaire R2 vient des lignes, pas du bucket.** wrangler n'a pas de
commande qui liste un bucket, donc une CLI sans dépendance ne peut pas
l'interroger — mais ce n'est pas le motif principal. Ce qu'une restauration doit
reproduire, c'est l'ensemble des objets dont les **lignes** ont besoin : `media`
est le seul propriétaire d'une image stockée (invariant 10) et un livrable
numérique est nommé par le produit qui le vend. Un objet que plus rien ne
référence n'est pas la boutique. La direction inverse est signalée plutôt que
réparée : une clé portée par un produit sans ligne `media` derrière est une
image déjà cassée, et une sauvegarde est un bon moment pour l'apprendre.

**Les octets accompagnent l'inventaire, et c'est un ajout assumé à l'ADR.**
L'ADR 0005 énumère « l'inventaire des objets R2 » ; une restauration qui ne
rendrait que l'inventaire laisserait une boutique aux images cassées, et le
critère de sortie parle d'un **nouvel** environnement. `--no-media` reste
disponible et l'archive dit alors ce qu'elle ne porte pas ; une restauration
depuis une telle archive refuse de s'exécuter sans `--allow-missing-media`.

**Une restauration ne peut pas être « presque » testée, alors elle se prouve
elle-même.** La commande relit la base qu'elle vient d'écrire et la compare,
table par table, aux empreintes que l'archive portait ; une différence fait
échouer la commande et nomme la table. C'est la « comparaison avant/après » du
jalon, pas un rapport annexe : elle est dans le chemin.

**Deux défauts trouvés en écrivant la suite, tous deux réels.**

- **une colonne que SQLite calcule ne se réinsère pas.**
  `orders.refunded_cents` est `GENERATED ALWAYS AS (…)` depuis la migration
  0025 : `SELECT *` la rend comme les autres, et un INSERT qui la nomme est
  refusé net. Une restauration qui ne le savait pas échouait sur la première
  boutique ayant une commande — c'est-à-dire sur toutes sauf celle des tests
  d'origine. La valeur est **capturée et comparée** quand même, et ce que la
  comparaison affirme devient plus fort : c'est l'expression de la cible qui a
  reproduit le même nombre ;
- **« vide » ne veut pas dire « zéro ligne ».** La migration 0040 sème les
  quatre pages légales françaises : une base provisionnée il y a cinq minutes
  en porte déjà. Une garde qui exigeait une base littéralement vide aurait
  réclamé `--overwrite` à **chaque** première restauration, et une option
  toujours obligatoire est une option que personne ne lit. Les tables que le
  schéma remplit lui-même sont donc déduites des migrations, comme la liste des
  tables l'est de `sqlite_master`.

**La conservation est bornée, et les deux bornes doivent être d'accord.**
`backup prune` ne supprime une archive que si elle dépasse **à la fois** le
nombre conservé et l'âge maximal. Une boutique qu'on a cessé de sauvegarder ne
doit pas voir sa dernière archive expirer sur un critère d'âge : que l'archive
soit vieille est la raison de la garder, pas celle de la supprimer. Un
répertoire incomplet — ce qu'une prise interrompue laisse — est la seule chose
qu'un âge seul emporte : il ne protège rien.

**Effacer une personne, c'est écrire, pas supprimer.** Une commande payée est
une pièce comptable que le Code de commerce garde dix ans ; l'article 17 du RGPD
demande que la personne disparaisse. `shopctl privacy anonymize` tient les deux :
le montant, la TVA, la date, le statut et l'identifiant public de la commande ne
bougent pas, et ce qui est réécrit est l'identité — l'e-mail devient un
pseudonyme, l'adresse de livraison est réduite au **pays**, qui est ce qui
justifie le taux de TVA appliqué, et tout ce qui désigne un colis chez un
transporteur passe à NULL. Une seule ligne est réellement supprimée, et c'est la
plus facile à oublier : un jeton d'accès invité dont la commande a été anonymisée
reste une clé qui ouvre la page de cette commande.

**Un condensat de l'adresse n'est pas un effacement.** L'ensemble des adresses
qu'une clientèle peut avoir s'énumère : un marchand qui possède sa liste de
diffusion condense chaque entrée et relit ses commandes anonymisées. Le
pseudonyme vient donc du CSPRNG, et il est tiré **une fois par ligne** — un
pseudonyme unique par personne aurait gardé ses commandes groupées, et un groupe
de commandes reste un profil même quand plus personne ne peut le nommer. Rien,
nulle part, ne conserve la correspondance ; c'est la seule valeur de toute la
CLI qui est faite pour être irrécupérable, et c'est pourquoi la commande exige le
slug saisi dans **tous** les environnements — une base de staging est le plus
souvent une copie restaurée de la production, avec les mêmes personnes dedans.

**La carte est déclarée parce qu'aucun schéma ne la porte, et elle est gatée
parce qu'une déclaration se périme.** `orders.email` et `products.name` sont tous
deux `TEXT NOT NULL` : la dérivation qui rend la sauvegarde complète n'existe pas
ici. Le compromis tient en une phrase : une heuristique sur le **nom** des
colonnes ne décide de rien, mais elle **refuse qu'une décision ne soit pas
prise** — toute colonne dont le nom peut porter une personne doit figurer dans la
carte, avec une action ou avec la raison de n'en avoir aucune, sans quoi la suite
échoue. Trente-six colonnes des quarante-trois migrations passent par là.
L'autre moitié, en revanche, est entièrement dérivée : quelles **lignes** sont
celles de la personne, ce sont les clés étrangères vers `orders` qui le disent, et
les quatre tables qui s'indexent sur un identifiant public au lieu du rowid sont
déclarées — sous un test qui refuse toute table portant une clé de commande sans
lien déclaré.

**Deux défauts sont sortis du lecteur de schéma, et aucun ne se voyait.** Les
deux dérivations lisent le texte du `CREATE TABLE` que porte `sqlite_master`,
pour s'épargner un processus wrangler par table sur une base distante. Ce marché
ne vaut que si le lecteur dit la même chose que SQLite — et il ne le disait pas.
Un commentaire de fin de ligne placé après une virgule (`status TEXT DEFAULT
'active', -- active | released`) tombe là où commence la colonne **suivante**, qui
se lit alors comme une clause sans nom : `checkout_reservations.expires_at`
disparaissait. Et un commentaire portant une apostrophe (`-- a total we didn't
have`, dans `refunds`) ouvrait un littéral qui avalait tout jusqu'au guillemet
suivant. Les deux étaient dans `migrations/`. Le test qui les a trouvés compare,
table par table, ce que le lecteur voit et ce que `PRAGMA table_xinfo` répond —
`table_xinfo` et non `table_info`, parce que celui-ci **cache** une colonne
générée virtuelle, et `orders.refunded_cents` en est une depuis la migration
0025. `generatedColumns`, dont dépend la restauration, lisait le même texte par
le même chemin.

**L'export est en clair, et c'est la décision.** Une sauvegarde est chiffrée
parce qu'elle est tous les acheteurs de la boutique et qu'elle est faite pour
dormir dans un dépôt. Un export est **une** personne, produit parce qu'elle l'a
demandé, et l'article 20 veut un format structuré et lisible par machine qu'elle
puisse effectivement utiliser : c'est du JSON, écrit en 0600, dans un répertoire
que Git ignore, et la commande dit que le fichier est à supprimer une fois
transmis. Le chiffrer n'aurait fait que déplacer le problème sur l'envoi de la
clé. Ce qu'il ne porte pas est nommé plutôt qu'omis : les jetons d'accès, parce
qu'un export voyage par e-mail et que celui-là est un mot de passe, et l'identité
de l'opérateur qui a examiné un remboursement, parce qu'un export est une
**divulgation** et que cette personne-là n'a rien demandé.

**Ce qui reste est laissé à un humain, et dit comme tel.** Le motif et la note
d'un remboursement sont du texte libre : une carte classe une colonne, elle ne
lit pas une phrase. La commande les compte, dit **où** ils sont — par
identifiant public, jamais en recopiant leur contenu, puisque le rapport finit
dans un ticket — et les laisse en place, parce qu'ils justifient un mouvement
comptable. Les identifiants Stripe restent pour la même raison inversée : les
effacer supprimerait le seul moyen de demander à Stripe le même effacement, et
la commande les liste comme une demande distincte à faire.

**Une anonymisation se vérifie en reposant la question.** Après l'écriture, les
mêmes prédicats sont réévalués : les racines ne doivent plus rien trouver, et
chaque colonne réécrite est relue. C'est ce qui rattrape le seul cas qu'aucun
soin dans le script ne peut couvrir — une commande passée par la même personne
entre la lecture et l'écriture. `restore` finit de la même façon et pour la même
raison (ADR 0005) : une restauration ne se teste pas « presque », et un
effacement encore moins, puisqu'il est le seul geste de cette CLI que rien ne
défait.

**Le double de wrangler porte maintenant une vraie base.** `d1 migrations
apply` applique les quarante-trois migrations du dépôt dans une base
`node:sqlite`, et `d1 execute` y exécute les instructions que la CLI produit.
Ce qui est éprouvé, ce sont donc les vraies contraintes, les vrais
déclencheurs, les vraies colonnes générées et le vrai découpeur d'instructions —
qui doit rester *aussi permissif que la plateforme*, apostrophes et
points-virgules compris dans une description produit, sous peine de faire
échouer la suite sur des données qui passent en production.

**Ce qui n'est PAS gaté, et pourquoi.** Trois choses, nommées plutôt qu'omises :

- **le chronomètre du critère de sortie.** La procédure existe et le tour
  complet est éprouvé ; ce qu'aucun double ne remplace, c'est une restauration
  minutée sur un compte Cloudflare réel. Cette ligne rejoint celles des jalons 6
  et 7 : les trois attendent le même premier passage réel ;
- **la supervision et les runbooks d'incident.** Une alerte se pose sur un
  compte Cloudflare, et un runbook décrit une procédure que quelqu'un a exécutée
  au moins une fois ; les deux attendent le même premier passage réel que les
  jalons 6 et 7. Depuis l'étape 0 de la certification, les runbooks sont écrits
  (`docs/operations/`) et la supervision est décidée : `shopctl monitor`, lancé
  chaque nuit, lit l'API GraphQL Analytics faute d'alerte Cloudflare
  équivalente aux plans d'une boutique ;
- **la rotation d'une clé.** `keygen` refuse d'écraser une clé existante — c'est
  elle qui ouvre les archives déjà prises — mais rien ne rechiffre un dépôt d'un
  jeu de clés vers un autre. Une agence qui doit tourner sa clé garde
  l'ancienne le temps que la rétention emporte les archives qu'elle ferme.

### Jalon 9 — Mise à jour de flotte

Durée indicative : 3 à 4 jours.

#### Livrables

- [x] tags du socle (`npm run check:release`, workflow `Release`) ;
- [x] `shopctl core upgrade` ;
- [x] `shopctl fleet status` ;
- [x] `shopctl fleet upgrade` ;
- [x] pull requests automatiques (`--open-pr`) ;
- [x] rapport de versions (`shopctl fleet report --format json`) ;
- [x] détection du drift ;
- [x] notes de migration (`docs/migrations/`).

#### Tests

- [x] mise à jour des deux boutiques témoins ;
- [x] thème inchangé ;
- [x] manifeste inchangé ;
- [x] conflit volontaire signalé ;
- [x] migration D1 additive ;
- [x] ancien Worker compatible avec le nouveau schéma — au niveau du schéma :
  l'écriture que la version précédente exécute est rejouée contre la base
  migrée ; ce qu'aucun double ne remplace est nommé plus bas ;
- [ ] rollback applicatif ;
- [x] boutique conservée sur l'ancienne version toujours fonctionnelle.

#### Critère de sortie

- [x] Une version du socle peut être proposée à plusieurs boutiques sans copie
  manuelle de fichiers et sans déploiement automatique non approuvé.
  `shopctl fleet upgrade --to <tag> --open-pr` fusionne un tag immuable dans
  chaque boutique déclarée, met son manifeste à jour, exécute ses portes et
  ouvre sa pull request ; aucune commande de ce chemin n'appelle
  `shopctl deploy`, et aucune ne fusionne une pull request. Éprouvé contre des
  dépôts git réels ; seule la forge est un double.

#### État

Le jalon tient en une phrase : **une version du socle se propose, elle ne
s'impose pas.** Tout le reste en découle, y compris ce qui a été refusé.

**Une flotte n'est pas découvrable, donc elle est déclarée.** `fleet.json` liste
les boutiques exploitées et le dépôt du socle dont elles prennent les versions,
et il vit dans l'espace de travail de l'agence — ni dans le socle, qui doit
rester neutre et que chaque client clone, ni dans une boutique. Balayer le
disque à la recherche de `client/client.yaml` aurait ramassé un essai
abandonné, le clone d'un collègue et la boutique d'un client parti ; la commande
qui lit cette liste **écrit**. Le registre est en JSON parce que le lecteur de
manifeste refuse les séquences délibérément (ADR 0008), et qu'un registre est
une liste : l'élargir pour servir un fichier que le commerçant ne voit jamais
aurait affaibli celui qui lit le fichier dont les valeurs deviennent des noms de
ressources Cloudflare.

**La version d'une boutique se lit dans son historique.** Le tag `v<semver>` le
plus récent fusionné dans `HEAD` fait foi ; `coreVersion` est une déclaration
que quelqu'un peut éditer. `shopctl core status` compare les deux et rapporte le
désaccord — c'est ce que l'ADR 0003 lui demande — et il le rapporte **même quand
le manifeste ne valide plus**, ce qui est le cas le plus fréquent : un manifeste
en avance sur son socle est refusé par la porte, et une commande d'état qui
refuserait de décrire la boutique laisserait l'exploitant sans rien.

**La dérive utile n'est pas la différence.** Une boutique diffère de son tag par
construction : son thème, son manifeste, ses contenus. Ce qui compte est ce
qu'elle a changé dans les fichiers que le **cœur** maintient, parce que c'est là
que la fusion devra choisir. Les fichiers **générés** sont comptés à part :
`wrangler.jsonc` est rendu depuis le manifeste, donc toutes les boutiques en
diffèrent depuis le jour de leur création, et une alerte toujours vraie
n'apprend qu'à ne plus la lire.

**Un conflit est laissé dans l'arbre.** La commande nomme chaque fichier et sa
propriété, s'arrête en code 6, et laisse les marqueurs : résoudre est un travail
git dans cet arbre, et un `--abort` automatique aurait détruit le seul
exemplaire de l'état à trois voies dont l'exploitant a besoin.
`--abort-on-conflict` existe pour l'appelant qui préfère l'inverse. Une boutique
en conflit n'arrête pas la flotte : l'échec est rapporté contre sa boutique et
la suivante est traitée.

**Trois refus sont durs, et chacun a coûté quelque chose ailleurs.** Un arbre de
travail modifié — la fusion mêlerait un travail en cours à un commit qui prétend
être une version du socle. Un retour en arrière — un tag publié est immuable
(ADR 0003). Une version qui réécrit une migration publiée — une base qui l'a
déjà exécutée ne la rejouera pas (ADR 0006), et la flotte diverge en silence.

**Publier une version est devenu une porte, parce que la première tentative a
échoué.** Une version du socle est écrite à **trois** endroits : `package.json`,
les manifestes témoins, et les notes de migration. Bumper le premier seul
produit une boutique qui fusionne le tag et **échoue à ses propres portes** —
`config:validate` compare chaque manifeste de l'arbre à la version du cœur, et
les témoins voyagent avec le socle. C'est arrivé au premier essai de bout en
bout de ce jalon. `npm run check:release` tient donc les trois d'accord à chaque
commit, refuse un tag déjà publié, refuse une migration réécrite et refuse une
migration destructive ; `node scripts/check-release.mjs --set <version>` écrit
la version partout et dépose le squelette des notes. Le workflow `Release`
exécute la suite complète **et** la construction depuis un clone vierge avant de
poser le tag — un tag est ce que quelqu'un clone.

**La porte a refusé la première publication, et elle avait raison.** Le premier
`Release` a été lancé pour `v0.1.0` ; ce tag existe depuis le jalon 6, et un tag
publié ne se déplace pas (ADR 0003). Ce qui avait fait croire le contraire est
plus intéressant que l'erreur : la porte ne consultait que les **tags du clone**,
et un clone fait sans tags — ce que rendent plusieurs hébergeurs de checkout —
répond « ce tag n'existe pas » pour un tag que le dépôt publie. Elle interroge
maintenant `origin` d'abord, et dit de quelle source vient sa réponse ; hors
ligne, elle annonce que la réponse ne vaut que localement plutôt que de la faire
passer pour celle du dépôt. Le socle est donc publié en **`v0.2.0`** : trois
jalons — paiement, exploitation, flotte — séparent `main` du jalon 6, et
`docs/migrations/v0.2.0.md` dit ce que le pas demande à une boutique (rien : ni
migration, ni binding, ni secret).

**Ce qui n'est PAS gaté, et pourquoi.**

- **le rollback applicatif.** La propriété qui le rend sûr est éprouvée — une
  migration additive est appliquée aux quarante-trois vraies migrations, puis
  l'écriture que la version précédente exécute est rejouée et acceptée ; une
  colonne arrivée `NOT NULL` sans défaut fait échouer ce test. Ce qui manque est
  le geste lui-même : redéployer la version d'avant sur un Worker réel, ce qui
  demande le même premier passage sur un compte Cloudflare que les jalons 6, 7
  et 8 attendent ;
- **la forge.** `gh pr create` et `gh pr list` sont joués par le double
  `test/fixtures/gh-double.mjs`, contre un dépôt git réel dont le remote GitHub
  est réécrit vers un dépôt nu local. La construction des arguments, l'analyse
  des réponses et le corps de la pull request — notes de migration comprises —
  sont les vrais ; le service ne l'est pas ;
- **le déploiement en staging après une fusion.** L'étape 5 du §3.4 reste une
  commande qu'un humain tape, listée dans la checklist que porte la pull
  request. L'automatiser reviendrait à déployer sans approbation, ce que le
  critère de sortie interdit.

### Jalon 10 — Certification finale

Durée indicative : 3 à 4 jours.

Le déroulé de la campagne — comptes, secrets, ordre des étapes, actions
humaines — est dans le [plan de certification](certification/plan.md).

#### Livrables

- [ ] rapport de tests ;
- [ ] rapport de sécurité ;
- [ ] rapport de performance ;
- [ ] preuve de restauration ;
- [ ] validation TVA/facturation ;
- [ ] checklist de lancement ;
- [ ] documentation de support ;
- [ ] décision go/no-go.

#### Critère de sortie

- [ ] Tous les critères de la section 8 sont satisfaits ou font l'objet d'une
  dérogation écrite, datée et accompagnée d'une mesure compensatoire.

## 7. Organisation de la CI

### 7.1 À chaque commit

Les noms ci-dessous sont ceux du dépôt. `npm run verify` enchaîne les quinze
premiers ; les autres sont des jobs distincts du workflow `Verify`.

- [x] chaîne d'outils (`npm run check:toolchain`) ;
- [x] scan de secrets de l'arbre suivi (`npm run check:secrets`) ;
- [x] manifestes, identifiants de flotte, neutralité du cœur
  (`npm run config:validate`) ;
- [x] propriété des chemins et dérive de `CODEOWNERS` (`npm run check:paths`) ;
- [x] cohérence de la version publiable — version, manifestes témoins et notes
  de migration d'accord, aucune migration publiée réécrite ou destructive
  (`npm run check:release`) ;
- [x] tests unitaires, de contrat storefront et d'import de catalogue
  (`vitest run` ; la porte catalogue s'adresse seule par
  `npm run test:catalog`) ;
- [x] diagnostics TypeScript et `.astro` (`astro check`) ;
- [x] frontière du storefront (`npm run theme:check`) ;
- [x] build de production et vérification du CSS compilé ;
- [x] scan de secrets des artefacts de build (`npm run check:secrets:artifacts`) —
  Vite fige `import.meta.env.*` à la construction, donc une valeur qui n'a
  jamais existé que dans un `.dev.vars` non suivi peut se retrouver compilée
  dans un bundle dont la moitié est servie aux navigateurs ;
- [x] dry run de déploiement et budgets de taille (`npm run check:deploy`) ;
- [x] porte de sécurité sur le Worker construit (`npm run test:security`, incluse
  dans `npm run test:integration`) — porte d'administration, Access, Turnstile,
  origine des formulaires, sessions, force brute, téléchargements, téléversements,
  traversée de chemin, en-têtes, absence de données personnelles dans les logs ;
- [x] intégration D1 en boîte noire (`npm run test:integration`) ;
- [x] pays Stripe cohérents avec le SDK épinglé ;
- [x] Worker MCP, typecheck et dry run (`npm run mcp:check`) ;
- [x] paquet `create-minshop` (`npm run scaffold:check`) ;
- [x] porte de propriété des chemins sur la pull request (job « File ownership ») ;
- [x] construction des boutiques témoins (job « Build shop »), qui fait aussi
  passer la porte de sécurité et le scan d'artefacts à la boutique **générée** :
  la campagne de certification du §1 s'exécute donc sur une boutique neuve le
  jour de sa création ;
- [x] construction de chaque thème que le job principal ne couvre pas
  (job « Verify theme ») ;
- [x] construction depuis un clone vierge (job « Build from a clean clone ») ;
- [x] porte navigateur par thème — axe, clavier, zoom, sans JavaScript,
  signature du design (job « Browser », `npm run test:browser`).
- [x] tests de la CLI — livrés aux jalons 2, 4, 6, 8 et 9 :
  `test/scripts/shopctl.test.mjs` (création), `catalog.test.mjs` (import),
  `provision.test.mjs` et `deploy.test.mjs` (compte, environnement,
  déploiement), `backup.test.mjs` et `restore.test.mjs` (archive et tour
  complet, contre les quarante-trois migrations réelles),
  `fleet.test.mjs` (mise à niveau d'un socle réel, flotte, pull requests) et
  `release.test.mjs` (porte de publication). Ils tournent dans `vitest run`,
  donc dans `npm run verify`, donc dans le job principal ;
- [x] isolation multi-client (`npm run test:tenant-isolation`) — deux boutiques
  témoins dans un seul compte et une seule forge, §8.3. Dans `vitest run` pour la
  même raison que les précédents : un défaut d'isolation qui n'est vu qu'à la
  campagne finale a déjà voyagé dans un tag ;
- [x] plancher de formatage (`npm run check:format`) — voir ci-dessous.

Objectif : moins de cinq minutes. Tenu : le workflow complet sur `main` prend
environ trois minutes et demie, les jobs tournant en parallèle.

Quatre entrées de la première version de cette liste ne désignaient aucun script
du dépôt. Trois avaient un nom réel — `npm run typecheck` est `astro check`, qui
couvre TypeScript et les diagnostics `.astro` en une passe ; `npm run test:unit`
est `vitest run` ; `npm run test:cli` arrive au jalon 2 avec la CLI.

La quatrième, `npm run format:check`, n'a pas d'équivalent : aucun formateur
n'est installé. La renommer vers `astro check` serait faux — un typecheck ne dit
rien de la mise en forme — donc la case est restée ouverte jusqu'à la décision.

**Décision (2026-10-06, étape 0 de la certification) : pas de formateur, un
plancher.** Une boutique reçoit chaque tag du socle par fusion (ADR 0016) : un
commit qui reformate le socle arrive en conflit dans chaque fichier du cœur
qu'une boutique a touché, et ce coût se paie une fois par boutique, à la montée
de version. L'arbre est déjà homogène ; `npm run check:format` garde ce qu'une
relecture ne voit pas et qu'une fusion remarque — fins de ligne LF, saut de
ligne final, aucun espace de fin, aucune indentation par tabulation dans le
code —, sur les seuls fichiers du cœur. Adopter Prettier reste possible : ce
serait un commit de reformatage unique, annoncé dans les notes de migration de
la version qui le porte.

### 7.2 À chaque pull request client

- [ ] `npm run verify` ;
- [ ] `npm run test:catalog` — le script existe depuis le jalon 4 ; ce qui
  manque ici est la CI du dépôt d'une boutique, pas la porte ;
- [x] `npm run test:tenant-isolation` — la porte existe et tourne déjà dans
  `vitest run`, donc dans `npm run verify`, donc à chaque commit du socle. La
  nommer séparément sert le dépôt d'une boutique, qui a besoin de la désigner
  seule ;
- [ ] `npm run test:e2e` ;
- [ ] `npm run test:a11y` ;
- [ ] `npm run test:visual`.

Les trois derniers noms ne désignent aucun script, comme les quatre du §7.1
avant eux, et pour la même raison : ils ont été écrits avant le dépôt. Ce qu'ils
décrivent existe et tourne — `npm run test:browser` les remplace toutes les
trois, ce que le README dit déjà : une seule suite Playwright contre le Worker
construit couvre le parcours, axe et la signature du design, par thème, dans son
propre job. Les découper en trois scripts qui construisent trois fois le même
Worker coûterait trois builds pour un signal identique.

Ce qui manque à cette section n'est donc pas une porte : c'est son sujet. Une
pull request client se fait dans le dépôt d'une **boutique**, et aucune n'existe
encore. Le socle porte les portes ; il ne peut pas porter la pull request de
quelqu'un d'autre. Les cases restent ouvertes et désignent cela.

### 7.3 Chaque nuit

- [x] D1 d'intégration propre ;
- [ ] checkout Stripe test ;
- [ ] webhook Stripe ;
- [ ] e-mail de test ;
- [ ] sauvegarde ;
- [ ] restauration vers un environnement éphémère ;
- [ ] smoke tests sur les deux boutiques témoins ;
- [x] audit des dépendances.

Le workflow `Nightly` (`.github/workflows/nightly.yml`, étape 0 de la
certification) porte les huit lignes. Les deux cochées tournent dans tout dépôt,
socle compris, sans compte : `npm run verify` sur une D1 bâtie des seules
migrations, et `npm audit` gaté au niveau `high` sur les dépendances
d'exécution du Worker et du serveur MCP. Les six autres interrogent le staging
d'une boutique — sauvegarde vers son bucket `-backups`, restauration de cette
archive par `shopctl restore --local` dans la D1 du runner, portes distantes,
session Stripe test expirée par l'API de Stripe dont le webhook doit rendre
l'unité réservée, e-mail de test — et restent ouvertes jusqu'à leur premier
passage réel (étape 8 de la certification). Chaque témoin est son propre dépôt
et porte ce workflow : les « deux boutiques témoins » sont deux nocturnes.

### 7.4 Avant la production

- [x] suite complète verte ;
- [ ] sauvegarde verte ;
- [x] migrations validées ;
- [x] smoke test staging vert ;
- [x] approbation GitHub Environment ;
- [x] smoke test production vert ;
- [x] rapport de déploiement conservé.

Le workflow `Deploy` (jalon 6) porte cette séquence : le job de vérification
passe **avant** l'approbation — un relecteur à qui l'on demande d'approuver une
mise en production doit approuver quelque chose dont on sait déjà que ça
construit et que ça passe sa suite —, le job de déploiement s'attache au GitHub
Environment qui porte les relecteurs obligatoires, `shopctl deploy` exécute le
smoke test public et le fait échouer s'il ne passe pas, et les deux rapports
JSON — ressources, verdicts de juridiction, bookmark, résultats du smoke test —
sont conservés quatre-vingt-dix jours en artefacts.

`sauvegarde verte` reste ouvert, mais plus pour la même raison : la sauvegarde
applicative existe depuis le jalon 8 (`shopctl backup`, plan §5.6, ADR 0005) et
son tour complet est éprouvé contre le vrai schéma, et depuis l'étape 0 de la
certification `shopctl deploy --env production` la prend lui-même, la copie dans
le bucket `-backups` de l'environnement et ne migre qu'ensuite — sans clé ou sans
bucket, il refuse de démarrer (ADR 0005, note du 2026-10-06). Ce qui manque est
le premier passage sur un compte Cloudflare réel. Le bookmark Time Travel pris avant les
migrations est un filet court terme, pas la sauvegarde, et le rapport le dit
avec ces mots.

## 8. Campagne finale de tests

### 8.1 Fonctionnel

- [ ] catalogue ;
- [ ] recherche ;
- [ ] catégories ;
- [ ] pagination ;
- [ ] variantes ;
- [ ] stock ;
- [ ] panier ;
- [ ] livraison ;
- [ ] promotions ;
- [ ] paiement ;
- [ ] remboursement ;
- [ ] e-mails ;
- [ ] administration ;
- [ ] export ;
- [ ] pages légales.

### 8.2 Paiement et cohérence

- [ ] commande créée une seule fois ;
- [ ] montant Stripe égal au montant D1 ;
- [ ] stock décrémenté une seule fois ;
- [ ] taxes et frais de livraison figés dans la commande ;
- [ ] webhook idempotent ;
- [ ] remboursement synchronisé ;
- [ ] échec d'e-mail sans perte de commande.

### 8.3 Isolation multi-client

- [x] deux dépôts — une boutique, un dépôt, une histoire : chacune pousse la
  sienne sur son propre remote, et aucun des deux remotes ne répond pour le
  commit de l'autre. C'est ce que la mise à niveau du §3.4 fusionne dans, donc
  deux boutiques qui partageraient une histoire prendraient le thème de l'autre
  à la prochaine version du socle ;
- [x] deux thèmes — `pilot-fr` sélectionne `atelier`, que le cœur ne possède
  pas ; `canary-minimal` sélectionne `market`, livré par le socle ;
- [x] deux Workers ;
- [x] deux bases — noms **et** identifiants distincts : la liaison D1 s'appelle
  `DB` dans toute la flotte, donc c'est l'identifiant rendu qui décide où une
  écriture atterrit ;
- [x] six buckets par paire d'environnements — images, fichiers et sauvegardes,
  staging et production. C'est un **compte** parce que la panne est un bucket
  *manquant* : un bucket de fichiers privés qu'une deuxième boutique réutilise
  remet les factures d'un commerçant à l'autre ;
- [x] aucun secret partagé — les secrets internes sont tirés par boutique et par
  environnement, chacun posé sur son seul Worker ; chaque dépôt reçoit son propre
  jeton Cloudflare par environnement — quatre jetons, aucun partagé — et aucune
  de ces valeurs n'apparaît dans un vecteur d'arguments ;
- [x] aucune donnée croisée — le catalogue témoin est importé dans **une** base
  et dans **un** bucket ; les trois autres bases du compte et les sept autres
  buckets sont vides. Et l'isolation est tenue par un **refus**, pas seulement
  par une observation : l'import s'arrête si le `wrangler.jsonc` de l'arbre
  décrit une autre boutique ou un autre environnement que celui demandé ;
- [x] versions du socle indépendantes — une boutique non sélectionnée reste sur
  sa version et passe toujours ses propres portes (`fleet.test.mjs`) ;
- [x] mise à niveau commune réussie — les deux boutiques témoins prennent le même
  tag, thème et manifeste inchangés (`fleet.test.mjs`).

Les sept premières lignes sont tenues par `npm run test:tenant-isolation`
(`test/scripts/tenant-isolation.test.mjs`), qui monte les deux boutiques témoins
**dans un seul compte Cloudflare et une seule forge** : c'est la seule
disposition où la faute est possible. Deux comptes, ou deux répertoires
temporaires, ne prouveraient que la séparation de deux répertoires.

Ce que la porte ne remplace pas. Les commandes, les rendus et le SQL sont les
vrais — les quarante-trois migrations du dépôt, l'import du catalogue témoin,
`shopctl repo` et `shopctl deploy` —, mais le compte Cloudflare et la forge sont
des doubles (`test/fixtures/wrangler-double.mjs`, `gh-double.mjs`). Les lignes
qui parlent de boutiques **déployées** — deux Workers répondant sur deux
origines, avec deux bases derrière — sont à rejouer telles quelles dans la
campagne finale, sur des comptes réels. La porte tient la moitié qui régresse,
et elle la tient à chaque commit.

### 8.4 Sécurité

- [ ] aucune vulnérabilité critique ou élevée non justifiée ;
- [ ] aucune clé dans Git, les logs ou les artefacts ;
- [ ] webhooks signés ;
- [ ] routes admin protégées ;
- [ ] rate limits actifs ;
- [ ] uploads contrôlés ;
- [ ] CSP et en-têtes présents ;
- [ ] aucune donnée de carte traitée par l'application ;
- [ ] aucune PII inutile dans les logs.

Sept de ces neuf lignes sont désormais gatées à chaque commit par
`npm run test:security` et `npm run check:secrets:artifacts` (jalon 8) ; elles
restent ouvertes ici parce que la campagne finale les rejoue sur une boutique
**déployée**, ce qu'aucune porte locale ne remplace. Les deux exceptions se
nomment : l'audit de vulnérabilités n'a pas de porte, et la CSP n'est que
partielle — `object-src`, `base-uri` et `frame-ancestors` sont posés sur toute
réponse depuis l'étape 0 de la certification ; `script-src` et `style-src` font
l'objet d'une dérogation écrite (`docs/certification/plan.md`, §6).

Le rejeu a son outil : `npm run test:security:remote` pose les mêmes questions
à une origine déployée — routes d'administration dérivées des fichiers,
assistant fermé, assertion Access forgée, origine des formulaires, traversée
de chemin, en-têtes sur chaque classe de réponse et sur les actifs statiques,
URL à capacité, erreur non rattrapée — et `npm run verify` le fait tourner
contre le Worker construit pour qu'il ne rencontre pas un Worker pour la
première fois le jour de la campagne.

### 8.5 Accessibilité et navigateurs

- [ ] zéro violation axe sérieuse ou critique ;
- [ ] navigation complète au clavier ;
- [ ] focus visible ;
- [ ] zoom 200 % ;
- [ ] contrastes suffisants ;
- [ ] Chrome desktop ;
- [ ] Firefox desktop ;
- [ ] Safari/iPhone ;
- [ ] Chrome/Android.

La porte navigateur vise aussi une boutique déployée :
`BASE_URL=… npm run test:browser:remote` retrouve dans le catalogue du marchand
les pages que les specs demandent et saute, en le disant, les états qu'il n'a
pas (une catégorie vide, la signature du design prise sur le jeu d'essai).

### 8.6 Performance

Objectifs internes initiaux :

- [ ] Lighthouse mobile supérieur ou égal à 90 en performance, accessibilité et SEO ;
- [ ] LCP inférieur ou égal à 2,5 secondes ;
- [ ] CLS inférieur ou égal à 0,1 ;
- [ ] INP inférieur ou égal à 200 ms ;
- [ ] aucune erreur Worker sous charge ;
- [ ] vingt utilisateurs virtuels pendant quinze minutes ;
- [ ] cinq checkouts concurrents sans survente.

Si le plan Workers Free dépasse régulièrement sa limite CPU ou génère des
erreurs de ressources, la boutique doit passer au plan Workers Paid.

- [x] Définir l'alerte et la procédure de passage au plan Workers Paid.

Les deux scénarios de charge existent (étape 0 de la certification) et
attendent leur passage sur staging : `npm run test:load:remote` (vingt
acheteurs, quinze minutes, la recherche cadencée sous son limiteur, échec sur
une seule 5xx) et `npm run test:last-unit:remote -- --product <slug>` (cinq
checkouts simultanés sur un stock vérifié à 1). L'alerte est `shopctl monitor`,
qui échoue au-delà de 1 % d'erreurs ou de 70 % d'un quota du plan gratuit et
que le nocturne lance chaque nuit ; la procédure est le runbook
`docs/operations/runbooks/worker-en-erreur.md`.

### 8.7 Résilience

- [ ] Resend indisponible ;
- [ ] webhook Stripe répété ;
- [ ] média R2 manquant ;
- [ ] échec réseau temporaire ;
- [ ] rotation des secrets ;
- [ ] mot de passe admin perdu ;
- [ ] rollback Worker ;
- [ ] restauration complète ;
- [ ] RTO inférieur ou égal à 60 minutes ;
- [ ] RPO inférieur ou égal à 24 heures.

### 8.8 Conformité et validation humaine

- [ ] revue des pages légales ;
- [ ] revue du consentement aux CGV ;
- [ ] revue TVA et facturation ;
- [ ] commande réelle ;
- [ ] remboursement réel ;
- [ ] lecture des e-mails dans Gmail, Outlook et Apple Mail ;
- [ ] recette par une personne extérieure au développement ;
- [ ] confirmation que les textes définitifs restent sous la responsabilité du
  marchand.

## 9. Conditions de déploiement d'une boutique

Un déploiement est bloqué lorsque :

- [ ] blocage si le manifeste est invalide ;
- [ ] blocage si la version du socle n'est pas supportée ;
- [ ] blocage si un test obligatoire échoue ;
- [ ] blocage si la sauvegarde préalable échoue ;
- [ ] blocage si le compte Cloudflare ne correspond pas ;
- [ ] blocage si la juridiction n'est pas celle attendue ;
- [ ] blocage si le bucket privé est public ;
- [ ] blocage si un secret est détecté ;
- [ ] blocage si une migration n'est pas rétrocompatible ;
- [ ] blocage si la staging n'a pas été validée ;
- [ ] blocage si l'approbation humaine production manque.

## 10. Estimation

| Jalon | Estimation |
|---|---:|
| 0 — Baseline | 2 j |
| 1 — Multi-client | 3–4 j |
| 2 — Générateur | 3–5 j |
| 3 — Socle français | 5–8 j |
| 4 — Catalogue | 3–4 j |
| 5 — Thème pilote | 4–6 j |
| 6 — Provisioning | 4–5 j |
| 7 — Paiement | 4–5 j |
| 8 — Exploitation | 5–6 j |
| 9 — Flotte | 3–4 j |
| 10 — Certification | 3–4 j |

Certaines tâches pourront se chevaucher, mais une version productisable complète
représente environ 35 à 45 jours de travail. Une version de démonstration peut
être obtenue plus tôt, après les jalons 0 à 7, mais ne doit pas être vendue avant
les tests d'exploitation et de restauration.

## 11. Jalons de décision

| Point de décision | Éléments exigés | Décision attendue |
|---|---|---|
| A — Socle | Jalons 0 à 2 | Minshop et la stratégie Git sont viables |
| B — France | Jalon 3 | TVA, facturation et conformité sont cadrées |
| C — Boutique | Jalons 4 à 7 | Le pilote est démontrable |
| D — Exploitation | Jalon 8 | Le pilote est exploitable |
| E — Flotte | Jalon 9 | L'offre est industrialisable |
| F — Certification | Jalon 10 | La commercialisation peut commencer |

## 12. Documentation obligatoire avant commercialisation

- [ ] architecture et ADR ;
- [ ] guide de création d'une boutique ;
- [ ] guide d'import de catalogue ;
- [ ] guide de personnalisation du thème ;
- [ ] procédure Stripe et Resend ;
- [ ] procédure de déploiement ;
- [ ] procédure de sauvegarde et restauration ;
- [ ] procédure de mise à niveau du socle ;
- [ ] procédure d'incident et de violation de données ;
- [ ] procédure de remboursement ;
- [ ] procédure de départ d'un client ;
- [ ] matrice des responsabilités agence/marchand ;
- [ ] liste des sous-traitants techniques ;
- [ ] modèle de recette et de procès-verbal de livraison.

## 13. Après le pilote

Pistes notées pendant le pilote et reportées après le MVP. Aucune n'est
engagée : chacune demande sa propre décision, et un ADR quand elle en contredit
un.

### 13.1 Un compte Cloudflare payant mutualisé

Notée le 2026-10-15, pendant la décision CPU de l'étape 6 (jalon 10). Si le plan
Workers Free ne tient pas ses 10 ms de CPU par requête, passer chaque
commerçant au plan Workers Paid sur son propre compte (ADR 0002) multiplie les
abonnements. La piste : un compte de l'agence en Workers Paid qui héberge
plusieurs boutiques.

- Workers Paid se facture **par compte** (5 $ par mois au minimum, 10 millions
  de requêtes et 30 millions de ms de CPU inclus), pas par Worker. La limite de
  10 ms est par requête : regrouper des boutiques dans un même Worker n'y
  change rien.
- Chaque boutique garde son Worker, sa D1 et ses buckets : l'ADR 0001 tient, et
  le code est prêt (la clé du limiteur de débit est préfixée par l'hôte,
  `src/features/auth/rateLimit.ts`).
- Le plafond est le nombre de crons : 250 par compte payant, et chaque
  environnement porte celui de `wrangler.template.jsonc`. Environ 250 boutiques
  si le staging disparaît à la mise en ligne, 125 s'il reste. Au-delà de
  500 Workers par compte, Workers for Platforms (25 $ par mois). Au plan
  gratuit, 5 crons : le compte de l'agence ne construit pas plus de cinq
  stagings à la fois, quelle que soit la décision.
- À trancher avant : un ADR qui restreint l'ADR 0002 à Stripe, Resend et au
  nom de domaine, et simplifie l'ADR 0015 ; la sortie d'un client devient une
  migration (sauvegarde puis restauration sur son compte, ADR 0005), et
  `docs/operations/sortie-client.md` est à réécrire ; le domaine du commerçant
  passe sur le compte de l'agence ou par Cloudflare for SaaS (100 noms
  gratuits, puis 0,10 $ par mois chacun) ; un incident sur le compte touche
  tout le parc, et la documentation ne montre pas de jeton D1 limité à une
  seule base.

Sources relevées le 2026-10-15 sur developers.cloudflare.com : tarifs et
limites de Workers, limites de D1, rôles et permissions de Workers, offres de
Cloudflare for SaaS.
