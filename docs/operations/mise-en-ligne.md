# Procédure — mise en ligne d'une boutique

La checklist de lancement, rejouable pour chaque boutique. Par défaut, la
boutique se construit directement en production sur le compte du client (B),
fermée jusqu'à l'ouverture, ses contenus y sont saisis, puis elle se certifie
par le [parcours court](../certification/par-boutique.md) (ADR 0015, amendé le
2026-10-27). Une boutique qui a eu une preview sur le compte de l'agence (A)
suit la même liste, puis la section 7. Écrite d'après l'étape 9 de la
certification (répétée le 2026-10-20, passée en réel du 2026-10-21 au
2026-10-23) ; chaque
commande se lance depuis l'arbre de la boutique, à jour de `main`, sous
Node 22. Un clone qui porte aussi le remote `core` fait refuser à `gh` de
choisir son dépôt : `gh repo set-default <owner>/<boutique>` une fois avant.

La production est **publique dès son premier déploiement** : le domaine
répond, son certificat est publié dans les journaux de transparence, et les
robots le trouvent dans l'heure. Trois protections tiennent la fenêtre entre
ce déploiement et l'ouverture : l'administration a déjà son mot de passe
(section 3) ; le paiement de démonstration est coupé (section 2), et le panier
dit que la commande est indisponible ; et la vitrine demande aux moteurs de ne
pas l'indexer (`noindex`, depuis `v0.3.29`). Les deux dernières tombent
d'elles-mêmes au premier moyen de paiement réel. N'annoncer la boutique qu'à
la fin.

## Sur le compte mutualisé

Une nouvelle boutique se construit sur le compte Cloudflare de l'agence
([ADR 0019](../architecture/decisions/0019-compte-cloudflare-mutualise.md)),
et non plus sur un compte du commerçant. La liste ci-dessous reste la bonne ;
six sections changent ainsi :

- **0. Prérequis** : le commerçant n'ouvre pas de compte Cloudflare. Il garde
  son domaine chez son registrar, ouvre Resend et Stripe à son nom, et ajoutera
  un CNAME à la section 2. Côté agence, une fois pour toutes : le compte
  mutualisé (Workers Paid, ou Free le temps d'une ou deux très petites
  boutiques, la variable `MINSHOP_ACCOUNT_PLAN` du dépôt de flotte le dit ; un
  seul Super Administrator, clé de sécurité matérielle), sa zone SaaS et son origine de repli (SSL/TLS → Custom
  Hostnames), le dépôt de flotte (`shopctl fleet init` puis `fleet repo`), et
  un widget Turnstile par lot de dix noms d'hôte. Le manifeste porte
  `cloudflare.accountId` = le compte mutualisé et `cloudflare.saasZone` = la
  zone SaaS, sans `productionAccountId` ;
- **1. Le dépôt** : aucun jeton Cloudflare dans le dépôt de la boutique.
  `npm run shopctl -- repo --fleet <propriétaire/flotte>` (ou `shopctl new
  --create-repo --fleet` à la création), puis la boutique inscrite dans le
  `fleet.json` du dépôt de flotte avec son `repository`, par une pull request
  de la flotte. Les relecteurs de la production et le jeton de lecture de
  `monitor` sont ceux de la flotte ;
- **2 et 3. Ressources et mot de passe** : depuis le poste de l'opérateur, avec
  son propre jeton du compte mutualisé (exporté sans écho, jamais posé dans un
  dépôt). `provision --env production` crée aussi le nom d'hôte personnalisé et
  affiche le CNAME à transmettre au commerçant : `<domaine> → <origine de
  repli>`. Le certificat suit seul une fois le CNAME en place ;
- **4. Le premier déploiement** : par le Deploy de la flotte,
  `gh workflow run deploy.yml -R <propriétaire/flotte> -f shop=<slug> -f environment=production`.
  Il refuse un nom d'hôte encore en attente : attendre le CNAME, ou relancer
  plus tard ;
- **6. Certifier** : le nocturne est celui de la flotte
  (`gh workflow run nightly.yml -R <propriétaire/flotte>`), qui sauvegarde et
  surveille chaque boutique de `fleet.json`. `certify` lit la flotte seule ;
- **7 et 8.** Une preview vit sur le même compte : elle se détruit sans changer
  de compte, `npm run shopctl -- destroy --env staging --confirm <slug>`. Les
  notifications du compte vont à l'agence seule : aucun commerçant n'est
  membre du compte mutualisé.

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
le dit et laisse l'environnement `staging` vide : sans preview, il ne sert pas,
et le nocturne n'interroge aucun staging qu'il ne voit pas déclaré.

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
  depuis `v0.3.22` : avec elle, une carte de test passait commande. Stripe
  configuré, le panier s'ouvre et la vitrine devient indexable, sans
  déploiement. Et le reçu de Stripe, à décider
  avec lui : la boutique envoie déjà le sien, et Stripe en ajoute un second si
  « Paiements réussis » est activé dans ses E-mails aux clients ;
- [ ] les **pages légales** écrites par le commerçant, relues par un conseil
  et publiées, le menu du pied de page. La page affiche son titre : le texte
  ne le répète pas en `# Titre`, sans quoi il paraît deux fois (les squelettes
  l'ont fait jusqu'à `v0.3.28`). Aucune ne garde un « [À COMPLÉTER] » :
  depuis `v0.3.25`, la production refuse d'en publier une, mais elle laisse en
  ligne celle qui l'était déjà (la production du pilote a vendu sous des CGV
  en squelette, étape 11 de la certification). Avant la première commande,
  `legal.termsVersion` dans `src/store.config.ts` nomme le texte publié ;
  il monte à chaque changement que l'acheteur devrait réaccepter.
- [ ] la **TVA et la facturation** validées par écrit par l'expert-comptable
  du commerçant, sur les questions de la section 3 de la
  [fiche de l'étape 11](../certification/etape-11-commandes.md), et
  `commerce.invoiceStrategy` qui en dit le résultat : un manifeste qui porte
  encore `pending-validation` ne vend pas ([ADR 0010](../architecture/decisions/0010-tva-facturation-et-consentement.md)).
  Une facture numérotée ou la franchise en base, si la réponse les demande,
  se construisent dans le socle avant la première vente (la certification
  les a reportées à la première boutique réelle).

Les contenus sont saisis sur B, jamais recopiés depuis A (ADR 0015) : le
catalogue par l'administration, ou par `shopctl catalog import --env production`
depuis le CSV du commerçant, les images avec lui. L'import lit le
`wrangler.jsonc` rendu pour la production : si un `git restore` l'a défait,
`provision --env production` le rend de nouveau, sans rien recréer.

Un second run du workflow `Deploy` : le test de fumée vert, sans
avertissement.

## 6. Certifier

Le nocturne doit avoir tourné au moins une fois sur la production : s'il
n'est pas encore passé, le lancer à la main.

```sh
gh workflow run nightly.yml
```

Attendu : `Production backup` vert, `backup verify` qui ouvre l'archive avec
la clé ; `Production error rate and quotas` vert ; « Aucun staging déclaré »
en avis, sans preview.

Puis, depuis la session qui a provisionné la production (section 2), `gh`
authentifié. La porte navigateur demande Chromium sur le poste, et Lighthouse
une clé d'API Google (gratuite, l'API PageSpeed Insights activée) : sans elle,
le quota anonyme est épuisé et les quatre mesures sont sautées.

```sh
npx playwright install chromium        # une fois par poste
read -rs PAGESPEED_API_KEY && export PAGESPEED_API_KEY
npm run shopctl -- certify --env production
```

Elle lit tout ce que la [certification par boutique](../certification/par-boutique.md)
juge — socle, arbre, compte, base, vitrine publique, dépôt — en lecture seule,
et chaque ligne rouge dit quoi faire. Les limiteurs ne tournent qu'avec
`--rate-limits`, depuis le poste de l'opérateur : son adresse ne pourra plus se
connecter à l'administration pendant un quart d'heure, ni passer commande
pendant une minute.

Ensuite la **recette**, sur la boutique publique, avec un vrai paiement
remboursé : le commerçant, ou une personne qu'il désigne et qui n'a ni
développé ni exploité la boutique, avec le [modèle](recette.md) seul. Son
achat est celui des attestations : l'agence n'en fait pas un second.

- [ ] le procès-verbal signé, sans anomalie bloquante. Il marque la
  livraison : la boutique ne s'annonce qu'après. La première boutique réelle
  est la première à passer par une personne extérieure : le vendeur du pilote
  est fictif.
- [ ] `client/certification/attestations.yaml` rempli (achat, e-mails,
  téléphone, procès-verbal, relecture des pages légales, réponse de
  l'expert-comptable), sans adresse ni nom de client ;
- [ ] `npm run shopctl -- certify --env production --write` vert, et
  `client/certification/<date>/` avec les attestations versés par une pull
  request de la boutique. Sa fusion vaut certification.

## 7. Avec une preview : détruire la copie de l'agence

Seulement pour une boutique construite d'abord sur le compte de l'agence
(ADR 0015, étapes 1 et 2). Sur le compte A, une fois la production saisie et
contrôlée :

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
