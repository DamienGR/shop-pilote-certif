# Étape 1 — Comptes et accès

Ce guide accompagne l'étape 1 du [plan de certification](plan.md). Il dit, pour
chaque compte, quoi créer, dans quel ordre, quelle valeur relever et où elle
servira. Il ne lance rien sur un compte : les seules commandes sont
`wrangler login`, `wrangler whoami` et `shopctl doctor`, qui lisent.

Il se rejoue pour chaque nouvelle boutique : seuls le compte du client, les
domaines et les adresses changent.

## Deux règles

- **Un secret naît là où il vit.** Une valeur qui ne s'affiche qu'une fois —
  jeton API, secret de webhook, jeton de service Access, clé Resend — est créée
  au moment où sa destination existe, et collée directement dedans. L'étape 1
  crée des comptes et relève des identifiants ; les secrets arrivent aux étapes
  2, 3, 9 et 10 ([§ 9](#9-ce-qui-est-relevé-et-quand-chaque-secret-naît)).
- **Rien ne transite par une conversation** (plan §2.3), pas même un
  identifiant de compte. Les valeurs relevées ici vont dans le gestionnaire de
  mots de passe de l'opérateur, puis dans le manifeste à l'étape 2.

## Ordre

Le plus long d'abord ; le reste tient en une soirée.

1. Stripe : lancer l'activation du mode live, qui prend des jours ouvrés ;
2. domaines : faire passer les deux zones sur Cloudflare (la propagation des
   serveurs de noms prend de quelques heures à 48 h) ;
3. Resend : vérifier le domaine d'envoi, une fois sa zone active ;
4. comptes Cloudflare A et B, R2 sur chacun ;
5. Zero Trust et l'application Access sur A ;
6. Turnstile ;
7. GitHub : le plan du compte qui portera les dépôts ;
8. poste de l'opérateur : `wrangler login`, `shopctl doctor`.

## 1. Stripe

- **À qui est le compte.** Pour une vraie boutique, le marchand l'ouvre à son
  nom, parce que le contrat d'acquisition l'engage lui, et y donne à l'agence
  un rôle restreint (ADR 0002). Pour le pilote, qui n'a pas de client, le
  compte est au nom de l'opérateur et joue le client, comme le compte
  Cloudflare B. Il n'est pas fictif pour autant : l'activation vérifie
  l'identité et le compte bancaire, et l'étape 10 y encaisse une vraie
  commande. De fausses informations font refuser l'activation ou fermer le
  compte.
- Un seul compte suffit : son mode test sert au staging, son mode live à la
  production.
- Le mode test est disponible dès la création du compte.
- **Lancer l'activation du mode live tout de suite.** Stripe demande la forme
  juridique et, s'il y en a un, le SIREN, l'adresse, l'identité du
  représentant légal avec une pièce justificative, un IBAN pour les virements,
  une description de l'activité ou l'adresse du site, et le libellé des
  relevés bancaires. Le site de production ne répondra qu'à l'étape 9 :
  décrire l'activité plutôt que donner une adresse qui ne répond pas.
- Activer la double authentification.
- Rien à relever. Les clés viennent aux étapes 3 et 10, **restreintes** :

| Clé | Droits | Ce que le code en fait |
|---|---|---|
| clé de la boutique (coffre) | Checkout Sessions en écriture, Shipping Rates en lecture, Refunds en écriture | `src/features/payments/stripe.ts` crée, relit et liste des sessions, relit le tarif d'expédition choisi, rembourse |
| clé du nocturne | Checkout Sessions en écriture | `test/remote/stripe-webhook.mjs` expire une session ; une clé live est refusée |

Si un droit manque, l'erreur de Stripe le nomme : la vérification a lieu au
premier checkout de l'étape 3.

## 2. Domaines

Deux domaines, un par compte : une zone n'appartient qu'à un compte, et le
domaine personnalisé d'un Worker demande une zone active sur le compte qui
porte ce Worker.

| Domaine | Compte | Champ du manifeste | À savoir |
|---|---|---|---|
| un nom d'hôte de preview, par exemple `preview.<domaine de l'agence>` | A | `cloudflare.stagingDomain` | ce nom ne doit porter aucun enregistrement DNS : Cloudflare refuse un domaine personnalisé sur un nom qui a déjà un CNAME |
| le domaine de la boutique | B | `cloudflare.productionDomain` | il sert aussi de domaine d'envoi |

Pour chacun : ajouter le site à Cloudflare (offre Free), remplacer chez le
registraire les serveurs de noms par ceux que Cloudflare indique, attendre
l'état « Actif ».

## 3. Resend

- Domaine d'envoi : celui de la production, dans la zone du compte B. Si Resend
  propose une région, choisir l'Europe (ADR 0004).
- Créer dans la zone les enregistrements que Resend affiche (DKIM, SPF et MX de
  retour), puis attendre l'état « Verified ».
- Relever l'adresse d'expédition, par exemple `commandes@<domaine>` : c'est
  `email.from` dans le manifeste.
- La clé API vient à l'étape 3, avec le seul droit d'envoi et limitée à ce
  domaine.

## 4. Comptes Cloudflare A et B

- **A, l'agence** : le compte existant de l'agence convient.
- **B, le client** : un second compte, créé comme un marchand le ferait, avec
  une autre adresse e-mail, puis l'utilisateur de l'agence invité comme
  administrateur (Gérer le compte → Membres). C'est le geste qu'un vrai client
  fera (ADR 0002), et c'est ce qui laisse une seule session `wrangler login`
  voir les deux comptes.
- **R2 activé sur chacun.** Tant qu'il ne l'est pas, `provision` échoue à la
  création du premier bucket. Le tableau de bord peut demander un moyen de
  paiement, même pour l'offre gratuite.
- Double authentification sur les deux comptes.
- Relever les deux identifiants de compte : premier segment de l'URL du tableau
  de bord, ou `npx wrangler whoami`.

### Jetons API

Un jeton par environnement, créé sur le compte de cet environnement (staging à
l'étape 2, production à l'étape 9). Partir du modèle « Edit Cloudflare
Workers », puis :

- ajouter **D1** en écriture et **Account Analytics** en lecture ;
- *Account Resources* : ce seul compte ;
- *Zone Resources* : cette seule zone — celle de `stagingDomain` pour staging,
  celle du domaine de production pour la production.

| Droit | Ce que `shopctl` en fait |
|---|---|
| Workers Scripts, écriture | `deploy`, `versions list`, `secret list` et `secret put` |
| D1, écriture | création et lecture des bases, migrations, `d1 execute` (sauvegarde, import), signet Time Travel |
| Workers R2 Storage, écriture | buckets dans leur juridiction, règle de cycle de vie, objets des sauvegardes |
| Workers Routes, écriture, sur la zone | le domaine personnalisé du Worker |
| Account Settings et Memberships, lecture | `wrangler whoami`, que `shopctl` lit pour refuser le mauvais compte |
| Account Analytics, lecture | `shopctl monitor --env staging` dans le nocturne |

Le jeton de lecture de la production (`MONITOR_CLOUDFLARE_API_TOKEN`) est un
autre jeton, sur B : Account Analytics et D1 en lecture, rien d'autre (plan
§2.3).

## 5. Zero Trust et Access (compte A)

- Zero Trust → choisir un nom d'équipe, celui de
  `https://<équipe>.cloudflareaccess.com`. Relever le nom seul : c'est
  `cloudflare.stagingAccessTeam`, et le socle écrit le reste de l'adresse.
  L'offre Free suffit ; le tableau de bord peut, là aussi, demander un moyen de
  paiement.
- Access → Applications → Self-hosted, sur le nom d'hôte de preview exact,
  sans chemin : l'application couvre la vitrine **et** l'administration.
- Une politique « Allow » sur les adresses de l'opérateur et du client qui
  regardera la preview ; le code à usage unique par e-mail suffit comme méthode
  de connexion.
- Relever l'**Application Audience (AUD) Tag** : c'est
  `cloudflare.stagingAccessAud`. `provision` et `deploy` rendent les deux
  valeurs en `CF_ACCESS_TEAM_DOMAIN` et `CF_ACCESS_AUD` dans le seul Worker de
  staging ; sans elles, le Worker refuse l'assertion d'Access et
  `/admin/setup` répond 403.
- Le jeton de service et sa politique « Service Auth » viennent à l'étape 3 :
  son secret ne s'affiche qu'une fois et va droit dans l'environnement
  `staging` du dépôt, qui n'existe qu'après l'étape 2.

## 6. Turnstile

- Sur A : un widget en mode « Managed », sur le nom d'hôte de preview.
- Sur B, à l'étape 9 : un second widget sur le domaine de production — les
  contenus et réglages de la production sont saisis sur B (ADR 0015).
- Relever la clé de site. La clé secrète reste lisible dans le tableau de bord ;
  les deux vont dans Admin → Réglages → Protection à l'étape 3.

## 7. GitHub : le plan

Les workflows `Deploy` et `Nightly` lisent leurs secrets dans les environnements
`staging` et `production`. D'après la
[documentation de GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
relue le 2026-10-06 puis le 2026-10-08 :

| Plan du compte, visibilité du dépôt | Secrets d'environnement | Relecteurs obligatoires |
|---|---|---|
| Free, Pro ou Team, dépôt public | oui | oui |
| Free, dépôt privé | non | non |
| Pro ou Team, dépôt privé | oui | non |
| Enterprise, dépôt privé | oui | oui |

Les minutes d'Actions comptent aussi
([facturation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)) :
gratuites et sans limite sur un dépôt public, 2 000 par mois sous Free et 3 000
sous Pro pour l'ensemble des dépôts privés du compte. Sans moyen de paiement,
Actions s'arrête au quota.

**Une vraie boutique** a un dépôt privé, ce que `shopctl repo` crée par défaut.
Il faut alors **GitHub Pro au minimum** sur le compte qui porte les dépôts. Les
relecteurs obligatoires n'existent sur un dépôt privé qu'avec Enterprise : sans
lui, la ligne §9 « approbation humaine » prend la dérogation du plan §6 — seul
l'opérateur a les droits d'écriture, et `deploy --env production` exige `--yes`.
`shopctl repo` tente les relecteurs et dit quand GitHub les refuse.

**Le pilote**, décidé le 2026-10-08 : le compte reste en Free et les deux dépôts
de boutique sont publics, créés par `shopctl repo --public`. Ils ont les
secrets d'environnement, un relecteur obligatoire sur `production` et des
minutes sans limite. Ce qui devient public :

- le socle et tout son historique jusqu'au tag cloné, adresses e-mail des
  auteurs de commits comprises, puis l'historique de chaque tag fusionné par
  une montée de version (étape 8) ;
- le manifeste : identifiants de compte, domaines, nom d'équipe et AUD
  d'Access, dont aucun n'est un secret ;
- les journaux de la CI, et les rapports qu'elle garde en artefacts :
  identifiants, comptes de lignes, empreintes, verdicts.

Les secrets ne le deviennent pas : GitHub les masque dans les journaux et ne
les rend jamais. Les archives de sauvegarde non plus : elles vont dans le
bucket `-backups` de l'environnement, jamais en artefact.

## 8. Poste de l'opérateur

```sh
nvm use 22
npm ci
npx wrangler login       # une session qui voit A et B
npx wrangler whoami      # les deux comptes listés, avec leur identifiant
gh auth login
npm run shopctl -- doctor
```

`doctor` doit finir sans ✗. Ses lignes « À faire par un humain » reprennent la
liste de cette étape ; il ne les vérifie pas, il les nomme.

## 9. Ce qui est relevé, et quand chaque secret naît

Relevés à l'étape 1 — des identifiants, pas des secrets :

| Valeur | Où elle ira | Étape |
|---|---|---|
| identifiant du compte A | `cloudflare.accountId`, et `--account` de `shopctl new` | 2 |
| identifiant du compte B | `cloudflare.productionAccountId` ; secret de dépôt `MONITOR_CLOUDFLARE_ACCOUNT_ID` | 2 ; 9 |
| nom d'hôte de preview | `cloudflare.stagingDomain` | 2 |
| domaine de production | `cloudflare.productionDomain` | 2 |
| adresse d'expédition | `email.from` | 2 |
| nom d'équipe Access, AUD | `cloudflare.stagingAccessTeam` et `cloudflare.stagingAccessAud` | 2 |
| clé de site Turnstile | Admin → Réglages → Protection | 3 |
| adresse de l'e-mail de test | variable `NIGHTLY_EMAIL_TO` de l'environnement `staging` | 3 |

Secrets, créés au moment où leur destination existe :

| Secret | Créé à l'étape | Collé dans |
|---|---|---|
| clé de sauvegarde | 2, `shopctl backup keygen` dans l'arbre de la boutique, avant de relancer `shopctl repo` | `.shopctl/backup.key` (0600), puis `SHOPCTL_BACKUP_KEY` posé par `shopctl repo` ; sans elle, la sauvegarde du nocturne de l'étape 3 échoue |
| jeton API de staging (A) | 2, juste avant le premier `shopctl repo` | variable `CLOUDFLARE_API_TOKEN_STAGING` du shell qui lance `shopctl repo` |
| clé Stripe test restreinte, secret du webhook test | 3 | coffre, Admin → Réglages → Paiements |
| clé Stripe test du nocturne | 3 | secret `STRIPE_TEST_SECRET_KEY` de `staging` |
| clé Resend | 3 | coffre |
| clé secrète Turnstile | 3 | Admin → Réglages → Protection |
| jeton de service Access | 3 | secrets `CF_ACCESS_CLIENT_ID` et `CF_ACCESS_CLIENT_SECRET` de `staging` |
| mot de passe admin de staging | 3, `/admin/setup` | secret `MINSHOP_ADMIN_PASSWORD` de `staging` |
| jeton API de production (B), jeton de lecture de la production | 9 | `CLOUDFLARE_API_TOKEN_PRODUCTION` puis `shopctl repo` ; secret de dépôt `MONITOR_CLOUDFLARE_API_TOKEN` |
| clés Stripe live, secret du webhook live | 10 | coffre de la production |
