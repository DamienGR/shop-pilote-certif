# Runbook — le Worker répond en erreur

**Déclencheurs** : le run nocturne ou `shopctl monitor` signale un taux
d'erreurs, la boutique affiche une page d'erreur Cloudflare (1101 : exception
du Worker ; 1102 : CPU dépassé ; 1027 : quota quotidien du plan gratuit), un
client ou le commerçant le signale.

**Objectif** : une vitrine qui répond en moins de quinze minutes. On revient
d'abord à ce qui marchait ; on comprend ensuite.

## 1. Constater (2 minutes)

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<domaine>/
curl -sS -o /dev/null -w '%{http_code}\n' https://<domaine>/products
npx wrangler deployments list --name minshop-<slug>-production
```

- `/` en erreur et `/products` aussi : le Worker ou sa base.
- `/` répond, `/products` non : la liaison D1 (base supprimée, quota D1).
- Erreur **1027** : le quota quotidien du plan Workers gratuit est atteint ;
  aller directement à la section 4.
- Erreur **1102**, ou `shopctl monitor` qui compte des invocations arrêtées :
  le CPU du plan gratuit ne suffit plus ; section 4 aussi, après avoir écarté
  un déploiement récent (section 2).

## 2. Revenir en arrière (5 minutes)

Si un déploiement a eu lieu dans les dernières heures, c'est le premier
suspect. Le rapport de `shopctl deploy` (artefact `deploy-<slug>-production-…`
du workflow Deploy) nomme la version précédente ; à défaut,
`npx wrangler deployments list` la donne.

```sh
npx wrangler rollback <version> --name minshop-<slug>-production
```

Le retour arrière ramène **le code**, pas le schéma : les migrations sont
additives (ADR 0006), l'ancien code lit donc une base plus récente sans
erreur. Ne jamais tenter de « dé-migrer ».

## 3. Comprendre

```sh
npx wrangler tail minshop-<slug>-production --format pretty
```

Les journaux sont structurés et passent par `logSafe()` : aucune adresse
e-mail ni jeton n'y figure. Ne pas recopier une ligne de journal dans un ticket
sans l'avoir relue — un message de fournisseur peut nommer un client.

Causes vues ou plausibles :

- une variable ou un secret manquant après un déploiement (`AUTH_SECRET`,
  `SECRETS_KEK`) : `npx wrangler secret list --name minshop-<slug>-production` ;
  `shopctl deploy` repose les secrets internes absents, jamais ceux qui existent ;
- une migration non appliquée : `npx wrangler d1 migrations list
  minshop-<slug>-production-db --remote` ;
- un fournisseur indisponible (Stripe, Resend) : le paiement ou l'e-mail
  échouent, la vitrine doit continuer à répondre — si elle ne répond plus, c'est
  un défaut du socle à reproduire en test.

## 4. Limites du plan gratuit (erreurs 1027 et 1102)

Le plan Workers gratuit plafonne à 100 000 requêtes par jour ; au-delà, chaque
requête reçoit une page d'erreur jusqu'à la remise à zéro quotidienne (minuit
UTC). Il accorde aussi 10 ms de CPU par requête : Cloudflare tolère qu'un
isolat les dépasse de temps en temps — un démarrage à froid les dépasse
toujours —, et arrête les invocations d'un isolat qui les dépasse
régulièrement (erreur 1102). Pour savoir quelle page coûte quoi, une capture
prise pendant l'incident :

```sh
npx wrangler tail minshop-<slug>-production --format json > tail.json
npm run test:cpu:remote -- tail.json
```

Il n'y a pas de contournement côté boutique : le commerçant passe le
compte au plan **Workers Paid** (tableau de bord → Workers & Pages → Plans),
qui accorde trente secondes de CPU par requête et lève le quota quotidien.
C'est une action du commerçant, propriétaire du compte (ADR 0002) ; l'agence
le prévient dès que `shopctl monitor` dépasse le seuil d'alerte ou compte une
invocation arrêtée, pas le jour du blocage.

## 5. Après

- un défaut reproduit localement devient un test du socle ;
- une note datée dans le registre d'incidents de la boutique : heure de
  détection, heure de retour, cause, version revenue ;
- si des commandes ont pu être payées pendant l'incident sans être
  enregistrées, enchaîner sur [webhooks Stripe](webhooks-stripe.md).
