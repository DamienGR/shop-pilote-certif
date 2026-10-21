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

Une archive qui ne porte pas toutes les images que ses lignes nomment (un objet
perdu ou supprimé à la main avant la sauvegarde, que `backup` signale) est
refusée tant que `--allow-missing-media` n'est pas ajouté : les lignes
reviennent, ces images restent cassées.

### Vers un environnement neuf, ou un autre compte

Le coffre ne voyage pas. Les clés des fournisseurs (Stripe, Resend, Turnstile)
sont chiffrées en base avec la `SECRETS_KEK` du Worker qui les a écrites, et
ce secret ne quitte jamais son Worker : restaurées ailleurs — un autre
environnement, un autre compte, un Worker recréé par `destroy` puis
`provision` —, elles sont présentes et illisibles. `restore` les nomme, et si
Turnstile est activé, donne la commande qui le désactive : sans elle,
l'administration refuse toute connexion, et c'est là que les clés se
ressaisissent. Ensuite, Admin → Réglages : ressaisir chaque clé, réactiver
Turnstile. D'ici là, le paiement répond en erreur.

Restaurer dans un environnement neuf, c'est aussi le déployer :
`shopctl deploy --env <env>` (`--yes` en production) pose ses secrets
internes et lie le Worker à la nouvelle base. Sur un compte où personne n'a
encore ouvert Workers & Pages, l'ouvrir une fois avant : sans sous-domaine
workers.dev, Cloudflare refuse le cron après avoir téléversé le Worker (code
10063), et `deploy` s'arrête avant de poser les secrets internes ; le relancer
une fois la page ouverte. Les preuves de l'étape 8 de la certification
(`client/certification/etape-8/` du pilote) donnent le temps réel de chaque
étape : 29 minutes, du premier `provision` au test de fumée vert.

## 4. Revenir à la normale

- `shopctl deploy --env production --yes` si la base a été recréée (le Worker
  doit lier le nouvel identifiant) ;
- rouvrir l'encaissement ;
- réconcilier les paiements Stripe postérieurs au point de retour.

## 5. Après

- noter le temps réel de retour : c'est la mesure du RTO, et la campagne de
  certification la compare à 60 minutes ;
- rejouer les effacements RGPD faits depuis la date de l'archive
  (`shopctl privacy anonymize`, une fois par demande reçue depuis, que le
  commerçant tient) : une sauvegarde leur est antérieure, et la restauration a
  rendu les données qu'ils avaient effacées ;
- si la cause est une migration, elle devient un test (`npm run check:release`
  refuse déjà une migration publiée réécrite ou destructive).
