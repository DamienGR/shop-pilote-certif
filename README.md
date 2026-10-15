# Minshop Offer

Socle de travail pour industrialiser une offre de petites boutiques e-commerce
sur mesure à partir de [Minshop](https://github.com/ddyy/minshop).

Ce dépôt démarre par la définition du produit, de l'architecture multi-client et
des critères de qualité. Le code du fork Minshop et les outils CLI seront ajoutés
au fil des jalons décrits dans le
[plan d'implémentation](docs/implementation-plan.md).

## Objectif

Construire une offre e-commerce à faible coût d'exploitation pour des boutiques
ayant typiquement :

- moins de 100 produits ;
- environ 50 commandes par mois ;
- une seule langue et une seule devise ;
- un storefront visuellement sur mesure ;
- un panier, un checkout et un back-office standardisés ;
- peu ou pas d'intégrations métier spécifiques.

Le pilote doit produire simultanément :

1. une boutique française complète et exploitable ;
2. un socle commun versionné ;
3. une CLI permettant de créer et exploiter les boutiques suivantes ;
4. un processus de mise à jour de plusieurs boutiques sans partager leurs
   données ni leurs secrets.

## Décision d'architecture

L'architecture retenue est **multi-client au niveau du pilotage et mono-client
à l'exécution**.

```text
                         ┌───────────────────────────┐
                         │ Fork Minshop de l'agence │
                         │ socle FR, CLI et tests   │
                         └─────────────┬─────────────┘
                                       │ tags versionnés
                         ┌─────────────▼─────────────┐
                         │ Registre privé de flotte │
                         └───────┬──────────┬────────┘
                                 │          │
                    ┌────────────▼─┐      ┌─▼──────────────┐
                    │ Boutique A   │      │ Boutique B     │
                    │ dépôt dédié  │      │ dépôt dédié    │
                    └──────┬───────┘      └───────┬────────┘
                           │                      │
                    Cloudflare A           Cloudflare B
                    Worker/D1/R2            Worker/D1/R2
```

Chaque client dispose donc de ses propres :

- dépôt applicatif ;
- compte ou périmètre Cloudflare ;
- Worker ;
- base D1 ;
- buckets R2 ;
- domaine ;
- comptes Stripe et Resend ;
- secrets et sauvegardes.

La mutualisation concerne le code, les tests, les scripts, la supervision des
versions et les procédures d'exploitation. Elle ne concerne jamais les données
des acheteurs.

## Stack cible

- Minshop et Astro SSR ;
- TypeScript et Node.js 22 ;
- Tailwind CSS ;
- Cloudflare Workers ;
- Cloudflare D1 ;
- Cloudflare R2 ;
- Stripe Checkout ;
- Resend ;
- Cloudflare Access et Turnstile ;
- GitHub Actions et Wrangler pour la CI/CD ;
- Playwright, axe et Lighthouse CI pour la recette du storefront.

Pour les boutiques européennes, D1 et R2 devront être créés avec la juridiction
Cloudflare `eu`, et pas seulement avec un hint de localisation `weur`.

## Périmètre de l'offre initiale

### Inclus

- B2C France ;
- français et EUR ;
- prix TTC ;
- checkout invité ;
- moins de 100 produits ;
- variantes et stock simples ;
- Stripe Checkout ;
- livraison fixe, par poids ou franco ;
- promotions Stripe ;
- e-mails de commande et d'expédition ;
- catégories, recherche et pages éditoriales ;
- pages légales fournies par le marchand ;
- export des commandes ;
- sauvegarde et procédure de restauration.

### Hors périmètre

- multilingue et multidevise ;
- abonnements ;
- marketplace ;
- B2B avancé ;
- ERP, caisse ou comptabilité synchronisés ;
- points relais et tarifs transporteur en temps réel ;
- automatisation marketing ;
- produits hautement configurables ;
- recherche sémantique, Lightning et MCP.

Ces besoins pourront être proposés sur devis, mais ne doivent pas faire dériver
le socle de l'offre standard.

## Modèle de dépôts

Le présent dépôt a vocation à devenir le dépôt `agency-minshop-core` :

```text
.
├── docs/                         Plan d'implémentation et décisions (ADR)
├── shopctl/                      CLI d'agence : création et exploitation
├── create-minshop/               Générateur public amont (paquet npm)
├── schemas/                      Schémas générés des manifestes et imports
├── scripts/                      Portes de CI, provisioning, thèmes
├── src/                          Fork et extensions Minshop
├── mcp/                          Worker MCP, déployable séparé
└── test/                         Tests cœur, CLI, flotte et E2E
```

Une boutique est un **clone d'un tag du socle**, avec son historique
([ADR 0003](docs/architecture/decisions/0003-versionnement-du-socle.md)) : elle
conserve donc l'arbre entier ci-dessus, `shopctl/` compris, et y ajoute ce qui
lui appartient :

```text
shop-acme/
├── client/client.yaml            Manifeste : identité, marché, ressources, thème
├── imports/                      Sources du catalogue (CSV et médias)
├── public/                       Favicon et assets de marque
├── src/themes/acme/              Le design de la boutique
├── src/store.config.ts           Réglages de construction
├── theme.config.json             Le thème compilé
└── wrangler.jsonc                Généré depuis le manifeste
```

`shopctl new` crée `client/client.yaml`, `imports/` et le thème ; le reste
existe déjà dans le socle. La version du socle consommée est déclarée par le
manifeste (`coreVersion`), pas par un fichier séparé.

Les personnalisations client restent dans des chemins réservés — la liste est
`scripts/path-ownership.mjs`, et `npm run check:paths` échoue sur un chemin
qu'aucune règle ne couvre. Une modification fonctionnelle générique doit être
apportée au socle, publiée dans une version, puis propagée aux boutiques par
une pull request de mise à niveau.

## CLI

`shopctl` est livrée **par** le socle et versionnée **avec** lui : la CLI qui
crée une boutique depuis le tag `v1.2.0` est celle que ce tag transporte
([ADR 0009](docs/architecture/decisions/0009-forme-de-la-cli-shopctl.md)). Elle
n'a aucune dépendance et aucune étape de build, parce qu'elle doit tourner avant
qu'il n'existe un `node_modules` quelque part. Détail dans
[shopctl/README.md](shopctl/README.md).

```bash
npm run shopctl -- <commande>     # ou node shopctl/bin/shopctl.mjs <commande>

# La première boutique d'une machine n'a rien à cloner à la main. `--package=`
# est obligatoire : le paquet s'appelle `minshop`, la commande `shopctl`.
npx --package=github:DamienGR/minshop-platform#v1.0.0 shopctl new acme

# npx n'installe rien de durable : dans la boutique, la CLI est celle du clone.
cd shop-acme && npm run shopctl -- doctor
```

### Livré

```bash
# Créer le dépôt d'une boutique depuis un tag du socle (jalon 2)
#   --core   défaut : la version du socle depuis lequel la CLI tourne
#   --domain défaut : <slug>.example.com, ou <slug>.$MINSHOP_DOMAIN_SUFFIX
#   --account défaut : $CLOUDFLARE_ACCOUNT_ID
shopctl new acme --name "Boutique Acme" --create-repo

cd shop-acme

# Vérifier les outils, l'arbre courant et les prérequis
shopctl doctor

# Valider les manifestes de l'arbre courant
shopctl config validate

# Importer et vérifier le catalogue (jalon 4)
shopctl catalog validate ./imports/catalog.csv
shopctl catalog import ./imports/catalog.csv --dry-run
shopctl catalog import ./imports/catalog.csv

# Créer le dépôt GitHub, ses environnements et leurs secrets (jalon 6)
shopctl repo --reviewer <login-github>

# Provisionner des ressources isolées (jalon 6)
shopctl provision --env staging --dry-run
shopctl provision --env staging

# Déployer, avec test de fumée (jalon 6)
shopctl deploy --env staging
shopctl deploy --env production --yes

# Sauvegarder, contrôler, restaurer (jalon 8)
shopctl backup keygen                    # une fois : la clé, jamais affichée
shopctl backup --env production
shopctl backup list
shopctl backup verify <id>
shopctl backup prune --keep 30 --keep-days 90
shopctl restore --env staging --from <id>

# Répondre à une demande RGPD (jalon 8)
shopctl privacy export --env production --email <adresse>
shopctl privacy anonymize --env production --email <adresse> --confirm <slug>

# Suivre et prendre les versions du socle (jalon 9)
shopctl core status                      # déclaré, fusionné, retard, dérive
shopctl core upgrade --to v1.1.0 --open-pr

# Retirer un environnement d'un compte (jalon 6) — irréversible
shopctl destroy --env staging --confirm <slug>

# Depuis l'espace de travail de l'agence, sur la flotte déclarée (jalon 9)
shopctl fleet status
shopctl fleet verify
shopctl fleet upgrade --to v1.1.0 --open-pr
shopctl fleet report --format json
```

La sauvegarde est **applicative**, table par table, chiffrée, et lisible sans
Cloudflare — donc restaurable dans un autre compte, ce qui est la condition
d'une sortie propre du client
([ADR 0005](docs/architecture/decisions/0005-strategie-de-sauvegarde.md)). Elle
n'a pas le choix : le Time Travel de D1 ne couvre ni R2 ni un autre compte, et
`wrangler d1 export` échoue sur les tables virtuelles FTS5 de la recherche. Une
restauration se termine par une comparaison table à table avec ce que l'archive
portait ; une différence fait échouer la commande.

`shopctl privacy` répond aux deux droits que le RGPD exerce contre la base :
l'export est du JSON en clair destiné à la personne (article 20), et
l'effacement est une **anonymisation** — les montants, la TVA et les dates
restent, parce qu'une commande payée est une pièce comptable que le Code de
commerce garde dix ans ; c'est l'identité qui est réécrite, avec un pseudonyme
tiré au hasard dont rien ne conserve la correspondance
([ADR 0017](docs/architecture/decisions/0017-effacement-et-portabilite.md)).

Le cycle de vie d'une boutique compte quatre étapes, et la frontière entre le
compte Cloudflare de l'agence et celui du client tombe **avant la saisie des
contenus**, pas à la mise en ligne
([ADR 0015](docs/architecture/decisions/0015-cycle-de-vie-d-une-boutique.md)) :
construction et preview privée chez l'agence, saisie et production chez le
client. Cloudflare ne transfère rien entre comptes, donc placer la frontière
plus tard imposerait une migration de données à chaque livraison.

La locale, la devise, le marché et la juridiction n'ont pas d'option : chaque
énumération n'accepte aujourd'hui qu'une valeur, et l'élargir est une décision
de version de schéma
([ADR 0008](docs/architecture/decisions/0008-format-du-manifeste-client.md)),
pas un drapeau.

Une boutique complète tient en trois commandes : `shopctl new <slug> --account
<id> --create-repo`, puis `shopctl provision --env staging`, puis
`shopctl deploy --env staging`. La première peut s'appeler par `npx` depuis une
machine qui n'a jamais cloné le socle. Le dépôt est déduit — `<owner>/shop-<slug>` —
quand `--origin` ne le nomme pas. La première enveloppe `gh` pour créer le dépôt
— **privé** par défaut —, ses environnements et leurs secrets
([ADR 0014](docs/architecture/decisions/0014-automatisation-de-la-forge.md)).

Rien de ce qui touche un compte n'a de valeur par défaut. `provision` et
`deploy` exigent `--env`, `deploy --env production` exige `--yes`, et le compte
Cloudflare attendu doit être nommé — par `cloudflare.accountId` dans le
manifeste, par `--account`, ou par `CLOUDFLARE_ACCOUNT_ID` — deux sources qui
divergent arrêtant l'exécution
([ADR 0013](docs/architecture/decisions/0013-environnements-de-deploiement.md)).

Une mise à niveau **propose** une version, elle ne l'impose pas : elle fusionne
un tag immuable sur une branche, met le manifeste à jour, exécute les portes que
la boutique transporte et ouvre une pull request. Elle n'appelle jamais
`shopctl deploy` et ne fusionne aucune pull request — la mise en production
reste derrière l'approbation du GitHub Environment
([ADR 0016](docs/architecture/decisions/0016-registre-et-mise-a-niveau-de-la-flotte.md)).
La flotte est **déclarée** dans un `fleet.json` de l'espace de travail de
l'agence, jamais découverte par balayage : la commande qui lit cette liste
écrit.

### Contrat cible des jalons suivants

La commande ci-dessous n'est pas encore implémentée.

```bash
# Vérifier une boutique déployée
shopctl verify --env staging
```

La CLI devra rester idempotente, compatible `--dry-run` et `--json`, et ne
jamais recevoir ni afficher de secret dans les arguments ou les logs.

## Environnements

Chaque boutique possède au minimum deux environnements indépendants :

| Environnement | Usage | Paiement | Données |
|---|---|---|---|
| `staging` | Recette et validation | Stripe test | Fictives |
| `production` | Boutique publique | Stripe live | Réelles |

Convention des ressources
([ADR 0013](docs/architecture/decisions/0013-environnements-de-deploiement.md)) :

```text
minshop-{client}-{env}            Worker
minshop-{client}-{env}-db         D1
minshop-{client}-{env}-images     R2 public
minshop-{client}-{env}-files      R2 privé
```

L'environnement qualifie la **souche** du nom : une boutique reste une seule
famille `minshop-{client}*`, et `destroy-cf.sh` la retire d'un coup. La famille
non qualifiée — `minshop-{client}-db` — n'est pas un troisième environnement :
c'est celle que rendent les builds témoins et le développement local, dont aucun
ne joint un compte.

Le compte Cloudflare actif est comparé au manifeste avant toute opération, et
`shopctl` refuse de provisionner ou de déployer quand il ne correspond pas — ou
quand rien ne le nomme. La production porte le domaine personnalisé et ferme
`workers.dev` au même moment ; staging garde `workers.dev`, qui est le seul
moyen de l'atteindre.

## Stratégie de mise à jour

Chaque dépôt client conserve l'historique du socle et configure deux remotes :

- `origin` pointe vers le dépôt client ;
- `core` pointe vers ce dépôt de socle.

Une mise à niveau suit le flux suivant :

1. publication d'un tag du socle ;
2. création d'une branche dans le dépôt client ;
3. merge du tag ;
4. exécution de la suite de tests ;
5. déploiement en staging ;
6. tests synthétiques ;
7. ouverture d'une pull request ;
8. validation humaine ;
9. sauvegarde puis déploiement en production.

Les migrations de base doivent être additives et rétrocompatibles. Un rollback
du Worker ne restaure pas automatiquement l'ancien schéma D1.

Les étapes 1 à 4 et 7 sont outillées depuis le jalon 9 : le workflow `Release`
publie le tag après la suite complète et une construction depuis un clone
vierge, et `shopctl core upgrade --to <tag> --open-pr` fait le reste dans une
boutique — `shopctl fleet upgrade` le fait sur la flotte déclarée. Les étapes 5,
6, 8 et 9 restent des gestes qu'un humain déclenche, dans cet ordre, avec la
checklist que porte la pull request : automatiser un déploiement derrière une
fusion reviendrait à mettre en production sans approbation.

La version qu'une boutique porte se lit dans son **historique** — le tag le plus
récent fusionné dans `HEAD` — et jamais dans son manifeste : `coreVersion` est
une déclaration, et `shopctl core status` existe pour dire quand les deux ne
coïncident plus.

## Qualité et tests

Commandes cibles :

```bash
npm run format:check
npm run typecheck
npm run test:unit
npm run test:cli
npm run test:catalog
npm run test:tenant-isolation
npm run theme:check
npm run test:storefront-contract
npm run test:browser
npm run test:security
npm run test:restore
npm run verify
```

`npm run test:browser` remplace les trois entrées `test:e2e`, `test:a11y` et
`test:visual` de la première version de cette liste : une seule suite Playwright
contre le Worker construit les couvre toutes — parcours desktop et mobile, axe,
navigation clavier, zoom, parcours sans JavaScript, et la régression visuelle
sous forme de signature du design calculé plutôt que de comparaison de pixels
(voir docs/agents/browser-gate.md). Elle n'est pas dans `npm run verify` :
c'est la seule porte qui demande un navigateur, et la CI lui donne son propre
job par thème.

`npm run test:tenant-isolation` est la porte multi-client du plan §8.3. Elle
monte les deux boutiques témoins **dans un seul compte Cloudflare et une seule
forge** — la seule disposition où la faute est possible — puis vérifie ce qui
n'existe qu'à deux boutiques : deux dépôts, deux thèmes, deux Workers, deux
bases, six buckets par paire d'environnements, aucun secret partagé, aucune
donnée croisée. Toutes les autres suites du dépôt éprouvent **une** boutique, et
le défaut visé ici est celui d'une boutique juste seule et fausse à côté d'une
autre : un nom de ressource qui ne porte pas le slug, un identifiant lu dans
l'environnement plutôt que dans la boutique, un `wrangler.jsonc` rendu pour l'une
et laissé en place pendant qu'une commande écrit pour l'autre. Le compte et la
forge sont des doubles ; les commandes, les rendus, les quarante-trois
migrations et l'import du catalogue témoin sont les vrais. Elle est dans
`npm run verify`.

`npm run test:security` est la porte du jalon 8. Elle démarre le Worker
**construit** en processus, sur une base issue des vraies migrations, et lui
pose les questions qu'aucun test unitaire ne peut poser parce qu'elles portent
sur la chaîne assemblée plutôt que sur une fonction : une requête anonyme
atteint-elle l'administration, un formulaire d'une autre origine est-il refusé,
une session expirée ouvre-t-elle encore, un fichier ment-il sur son type, et ce
que le Worker imprime contient-il l'adresse d'un client. Les routes
d'administration éprouvées sont **dérivées** de l'arborescence, donc un endpoint
ajouté demain est couvert sans que personne ait à penser à cette suite. Elle est
incluse dans `npm run verify`, et la CI la fait aussi passer à la boutique
générée.

`npm run check:secrets:artifacts` complète le scan de secrets de l'arbre suivi
en relisant `dist/` : Vite fige `import.meta.env.*` à la construction, donc une
valeur qui n'existe que dans un `.dev.vars` non suivi peut se retrouver compilée
dans un bundle dont la moitié est servie aux navigateurs.
`npm run check:secrets:history` relit tout l'historique que les refs atteignent
encore : une clé supprimée de l'arbre reste dans chaque clone fait depuis.

Une boutique ne pourra pas être déployée lorsque :

- son manifeste est invalide ;
- sa version du socle n'est pas supportée ;
- les tests fonctionnels ou de thème échouent ;
- la sauvegarde préalable a échoué ;
- la juridiction Cloudflare n'est pas celle attendue ;
- un bucket privé est publiquement accessible ;
- des secrets sont détectés dans le dépôt ou les artefacts.

## Sauvegardes et objectifs de reprise

La sauvegarde D1 devra être applicative ou réalisée table par table afin de ne
pas dépendre d'un export global incompatible avec certaines tables FTS5. Elle
inclura :

- les données métier ;
- la version du schéma ;
- l'inventaire des objets R2 ;
- les sommes de contrôle ;
- un chiffrement ;
- un manifeste de restauration.

Objectifs initiaux :

- RPO maximal : 24 heures ;
- RTO maximal : 60 minutes ;
- restauration testée au moins une fois par trimestre.

Par défaut, une restauration se fait dans un environnement vide de staging. Une
restauration vers la production nécessitera une confirmation explicite.

## Jalons

| Jalon | Résultat principal |
|---|---|
| 0 | Fork Minshop reproductible et CI de base — livré |
| 1 | Manifestes et isolation multi-client — livré |
| 2 | Générateur `shopctl new` — livré |
| 3 | Socle français, TVA et facturation cadrées |
| 4 | Import de catalogue idempotent |
| 5 | Thème sur mesure du pilote |
| 6 | Provisioning Cloudflare et CI/CD |
| 7 | Paiement, stock, livraison et e-mails |
| 8 | Sécurité, sauvegarde et exploitation |
| 9 | Mise à jour de plusieurs boutiques |
| 10 | Certification finale du pilote |

Le détail, les tests et les critères de sortie de chaque jalon sont décrits dans
[docs/implementation-plan.md](docs/implementation-plan.md).

## État actuel

Le dépôt est en phase de cadrage :

- [x] architecture cible définie ;
- [x] périmètre du pilote défini ;
- [x] jalons et stratégie de tests définis ;
- [x] fork Minshop importé avec son historique upstream, en dépôt privé ;
- [x] décisions d'architecture initiales enregistrées ;
- [x] inventaire de la baseline relevé ;
- [x] CI initialisée (chaîne d'outils imposée, dry run de déploiement, budgets
  de taille, scan de secrets, build depuis un clone vierge) ;
- [ ] intégration D1 fiable en CI — échoue une fois sur deux, sur `main` comme
  sur les branches, voir « Défaut de baseline connu » dans le plan ;
- [ ] manifeste client implémenté ;
- [ ] CLI implémentée ;
- [ ] boutique pilote déployée ;
- [ ] deuxième boutique témoin déployée ;
- [ ] campagne finale validée.

## Documentation

- [Plan détaillé d'implémentation](docs/implementation-plan.md)
- [Décisions d'architecture (ADR)](docs/architecture/decisions/README.md)
- [Inventaire de la baseline](docs/architecture/baseline-inventory.md)
- [Documentation Minshop](https://github.com/ddyy/minshop)
- [Personnalisation d'un storefront Minshop](https://github.com/ddyy/minshop/blob/main/CUSTOMIZING.md)
- [Localisation des données D1](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Localisation des données R2](https://developers.cloudflare.com/r2/reference/data-location/)
