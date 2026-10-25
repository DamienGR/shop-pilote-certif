# Procédure — mise en ligne d'une boutique

La checklist de lancement, rejouable pour chaque boutique. Elle couvre le
dernier temps du cycle de l'ADR 0015 : la boutique a été construite sur le
compte de l'agence (A) et prévisualisée derrière Access ; elle est mise en
production sur le compte du client (B), ses contenus y sont saisis, puis la
copie de l'agence est détruite. Écrite d'après l'étape 9 de la certification
(répétée le 2026-10-20, passée en réel du 2026-10-21 au 2026-10-23) ; chaque
commande se lance depuis l'arbre de la boutique, à jour de `main`, sous
Node 22. Un clone qui porte aussi le remote `core` fait refuser à `gh` de
choisir son dépôt : `gh repo set-default <owner>/<boutique>` une fois avant.

La production est **publique dès son premier déploiement** : le domaine
répond, son certificat est publié dans les journaux de transparence, et les
robots le trouvent dans l'heure. Deux protections tiennent la fenêtre entre ce
déploiement et l'ouverture : l'administration a déjà son mot de passe (étape
3), et le paiement de démonstration est coupé (étape 2) — le panier dit que la
commande est indisponible tant qu'aucun moyen de paiement réel n'est configuré.
N'annoncer la boutique qu'à la fin.

## 0. Prérequis sur le compte du client (B)

- [ ] double authentification ; R2 activé ; **Workers & Pages ouvert une
  fois** (le sous-domaine workers.dev, sans lequel Cloudflare refuse le cron du
  Worker après l'avoir téléversé, code 10063) ;
- [ ] la zone du domaine de production sur B ;
- [ ] trois jetons API créés sur B (droits :
  [comptes et accès, §4](../certification/comptes-et-acces.md)) — le jeton de
  **déploiement** de la production, celui de la **sauvegarde nocturne** (D1 en
  lecture, Workers R2 Storage en écriture, Account Settings, Memberships et
  User Details en lecture, rien qui déploie), celui de **lecture** pour
  `monitor` ;
- [ ] le domaine d'envoi des e-mails vérifié chez Resend, et une clé d'API ;
- [ ] un widget Turnstile pour le nom d'hôte de production ;
- [ ] `cloudflare.productionAccountId` dans le manifeste, si B n'est pas le
  compte de `cloudflare.accountId`.

Les jetons s'exportent sans écho, jamais en argument :

```sh
read -rs CLOUDFLARE_API_TOKEN_PRODUCTION && export CLOUDFLARE_API_TOKEN_PRODUCTION
read -rs CLOUDFLARE_API_TOKEN_BACKUP && export CLOUDFLARE_API_TOKEN_BACKUP
```

## 1. Le dépôt

```sh
npm run shopctl -- repo --reviewer <login>
```

`repo` réécrit le jeton de `production`, crée l'environnement `backup` limité à
la branche par défaut et y pose le jeton de sauvegarde, le compte de B et la
clé de sauvegarde ; il refuse le jeton de production à cette place. Toujours
avec `--reviewer` : sans lui, l'environnement `production` est reposé sans
relecteur, ce que la commande signale. Sans `CLOUDFLARE_API_TOKEN_STAGING`, il
le dit et laisse le secret de staging tel quel : le staging vit jusqu'à la
section 7.

Le jeton de lecture va dans les secrets du dépôt :

```sh
gh secret set MONITOR_CLOUDFLARE_API_TOKEN      # collé, sans écho
gh secret set MONITOR_CLOUDFLARE_ACCOUNT_ID --body <id de B>
```

## 2. Les ressources de production

```sh
npm run shopctl -- provision --env production --dry-run
npm run shopctl -- provision --env production
```

Attendu : le compte B nommé par le manifeste, la base et les trois buckets dans
la juridiction, les buckets fichiers et sauvegardes privés, les migrations, et
« démonstration de paiement coupée ». Les secrets internes sont reportés au
premier déploiement.

Un **domaine d'images**, s'il en faut un : R2 → `<worker>-production-images` →
Settings → Custom Domains → le nom choisi ; puis `cloudflare.imagesDomain` dans
le manifeste, par une pull request. Seule la production le rend, et
`deploy --env production` refuse un domaine déclaré qui n'est pas attaché.

## 3. Le mot de passe d'administration, avant tout déploiement

```sh
npm run shopctl -- admin password --env production
```

Saisi deux fois sans écho. Sans lui, le premier déploiement ouvrirait
l'assistant `/admin/setup` à quiconque arrive le premier sur le domaine. Après
lui, l'assistant ne s'ouvre qu'après connexion. Le transmettre au commerçant
par un canal distinct ; le
[runbook du mot de passe perdu](runbooks/mot-de-passe-admin.md) est la même
commande.

## 4. Le premier déploiement

Par le workflow, pas depuis le poste : la sauvegarde préalable et
l'approbation en font partie.

```sh
gh workflow run deploy.yml -f shop=<slug> -f environment=production
gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Approuver dans GitHub (Actions → le run → Review deployments). Attendu :
`verify` vert, l'archive préalable dans `-backups`, les migrations, le domaine,
les secrets internes, et un test de fumée vert avec un avertissement : « pas
encore installée », l'assistant derrière la connexion. Le premier certificat
du domaine peut prendre quelques minutes : un test de fumée rouge sur une
erreur TLS ou réseau se rejoue en relançant le workflow, rien n'est à
défaire.

## 5. Installer et saisir sur B

Connexion sur `https://<domaine>/admin/login`, puis l'assistant : nom de la
boutique, fuseau. L'assistant propose le `client.displayName` du manifeste
(« Ma boutique » avant `v0.3.19`) : le corriger si ce n'est pas le nom que
voient les clients. Ensuite, dans Admin → Réglages :

- [ ] **E-mail** : l'expéditeur sur le domaine vérifié (jamais
  `onboarding@resend.dev`, qui ne livre qu'au titulaire du compte Resend), la
  clé Resend, un e-mail de test reçu, et le **destinataire des alertes de
  commande**. Le socle n'en a pas par défaut : sans lui, l'alerte de chaque
  commande est sautée, et rien ne la renvoie (la première commande réelle du
  pilote, étape 10 de la certification) ;
- [ ] **Protection anti-robots** : les clés du widget de production ;
- [ ] **Paiements** : Stripe, quand le commerçant ouvre — une clé **live**
  restreinte (droits : [guide des comptes, §1](../certification/comptes-et-acces.md#1-stripe)),
  l'endpoint de webhook du mode live sur `https://<domaine>/api/webhook` avec
  ses cinq événements ([plan, §2.3](../certification/plan.md)), et la carte
  de Réglages qui dit « mode live ». La production refuse une clé de test
  depuis `v0.3.22` : avec elle, une carte de test passait commande. Et le reçu de Stripe, à décider
  avec lui : la boutique envoie déjà le sien, et Stripe en ajoute un second si
  « Paiements réussis » est activé dans ses E-mails aux clients ;
- [ ] les **pages légales** relues et publiées, le menu du pied de page.

Les contenus sont saisis sur B, jamais recopiés depuis A (ADR 0015) : le
catalogue par l'administration, ou par `shopctl catalog import --env production`
depuis le CSV du commerçant, les images avec lui. L'import lit le
`wrangler.jsonc` rendu pour la production : si un `git restore` l'a défait,
`provision --env production` le rend de nouveau, sans rien recréer.

Un second run du workflow `Deploy` : le test de fumée vert, sans
avertissement.

## 6. Contrôler la boutique publique

```sh
BASE_URL=https://<domaine> npm run test:security:remote -- --limiteurs
```

Depuis le poste de l'opérateur : son adresse ne pourra plus se connecter à
l'administration pendant un quart d'heure, ni passer commande pendant une
minute. Attendu : tout vert, la connexion refusée au plus tard à la sixième
tentative. Tant que Stripe n'est pas configuré, le contrôle des champs de carte
dit « aucun moyen de paiement configuré » : le relancer une fois Stripe en
place.

Puis le nocturne, à la main, pour voir la sauvegarde de la production :

```sh
gh workflow run nightly.yml
```

Attendu : `Production backup` vert, `backup verify` qui ouvre l'archive avec la
clé ; `Production error rate and quotas` vert.

## 7. Détruire la copie de l'agence

Sur le compte A, une fois la production saisie et contrôlée :

```sh
CLOUDFLARE_ACCOUNT_ID=<id de A> npm run shopctl -- destroy --env staging --confirm <slug>
```

R2 refuse un bucket non vide ; le tableau de bord le vide (R2 → le bucket →
Settings → Empty Bucket), puis la même commande, qui reprend où elle s'est
arrêtée. Ensuite :

- [ ] `gh variable set STAGING_RETIRED --body <date>` : le nocturne cesse
  d'interroger un staging qui n'existe plus, et le dit ;
- [ ] le jeton de staging révoqué sur A ; les applications Access de la preview
  et leurs jetons de service supprimés ; l'endpoint de webhook Stripe de test
  qui visait la preview supprimé ; la clé Resend du staging révoquée ;
- [ ] les secrets de l'environnement GitHub `staging` supprimés (le jeton de A
  et le reste) : ils ne servent plus.

## 8. Après

La boutique s'annonce. Le nocturne de la nuit suivante est vert : sauvegarde
de la production, `monitor`, suite et audit. Abonner l'adresse de l'opérateur
et celle du commerçant aux notifications du compte B
([exploitation](README.md#ce-qui-reste-manuel)).
