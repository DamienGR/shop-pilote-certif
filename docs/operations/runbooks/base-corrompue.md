# Runbook — base de données corrompue ou perdue

**Déclencheurs** : des données incohérentes (commandes sans lignes, stocks
négatifs, produits disparus), une suppression accidentelle, une migration qui
a mal tourné, une base D1 supprimée.

**Objectifs** (ADR 0005) : RPO 24 heures, RTO 60 minutes.

## 1. Arrêter d'aggraver (5 minutes)

Une base qui reçoit encore des écritures pendant qu'on la répare mélange deux
états. Si les commandes continuent d'arriver :

- couper l'encaissement : Admin → Réglages → Général, désactiver « Panier et
  tunnel de commande » et « Achat immédiat » ; la vitrine reste lisible,
  plus rien ne passe en caisse ;
- noter l'heure exacte : c'est la borne de tout ce qui suit.

## 2. Choisir le point de retour

Deux filets, du plus fin au plus solide :

| Filet | Couvre | Fenêtre | Commande |
|---|---|---|---|
| Time Travel D1 | la base seule, à la minute | 7 jours (gratuit), 30 jours (payant) | `npx wrangler d1 time-travel restore` |
| Sauvegarde applicative | base **et** objets R2, chiffrée | 90 jours (bucket `-backups`) | `shopctl backup pull` puis `shopctl restore` |

Le bookmark pris avant les migrations de chaque mise en production figure dans
le rapport de `shopctl deploy` (artefact du workflow Deploy). Il est le bon
point de retour après une migration fautive.

## 3a. Retour par Time Travel

```sh
npx wrangler d1 time-travel info minshop-<slug>-production-db
npx wrangler d1 time-travel restore minshop-<slug>-production-db --bookmark=<bookmark>
# ou --timestamp=<horodatage Unix ou RFC 3339>
```

La restauration remplace la base entière : tout ce qui a été écrit après le
point choisi disparaît, commandes payées comprises. Les relever d'abord (Stripe
garde la trace de chaque paiement ; voir [webhooks Stripe](webhooks-stripe.md)
pour les réconcilier).

## 3b. Retour par la sauvegarde applicative

Depuis l'arbre de la boutique, avec la clé de sauvegarde
(`.shopctl/backup.key` ou `SHOPCTL_BACKUP_KEY`) :

```sh
npm run shopctl -- backup pull <id> --env production
npm run shopctl -- backup verify <id>
npm run shopctl -- restore --env production --from <id> --overwrite \
  --allow-production --confirm <slug>
```

L'identifiant est dans le rapport du déploiement ou du run nocturne qui l'a
prise. La restauration se prouve elle-même : elle relit la base écrite et la
compare table par table aux empreintes de l'archive ; une différence fait
échouer la commande en nommant la table.

Si la base a été **supprimée**, `shopctl provision --env production` la
recrée d'abord (vide, mêmes nom et juridiction), puis la restauration s'y
applique sans `--overwrite`.

## 4. Revenir à la normale

- `shopctl deploy --env production --yes` si la base a été recréée (le Worker
  doit lier le nouvel identifiant) ;
- rouvrir l'encaissement ;
- réconcilier les paiements Stripe postérieurs au point de retour.

## 5. Après

- noter le temps réel de retour : c'est la mesure du RTO, et la campagne de
  certification la compare à 60 minutes ;
- si la cause est une migration, elle devient un test (`npm run check:release`
  refuse déjà une migration publiée réécrite ou destructive).
