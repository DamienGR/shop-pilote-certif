# Runbook — les e-mails ne partent plus

**Déclencheurs** : des clients sans confirmation de commande, le commerçant
sans notification de vente, des liens de connexion qui n'arrivent pas, le
tableau de bord Resend en rebonds ou en refus.

**Ce qu'il faut savoir** : chaque e-mail de commande est une ligne de
`order_notifications`, écrite dans la même transaction que la commande. Une
commande n'est donc jamais perdue parce qu'un e-mail a échoué : la ligne reste
`pending`, le balayage planifié la retente, et elle passe `dead` après cinq
tentatives. Les commandes de démonstration n'envoient jamais de reçu au client,
seulement la notification au commerçant.

## 1. Constater

```sh
npx wrangler d1 execute minshop-<slug>-production-db --remote --command \
  "SELECT kind, state, COUNT(*) AS n, MAX(last_error) AS erreur FROM order_notifications GROUP BY kind, state"
```

(Rendre d'abord la configuration de production si la commande refuse le nom
de la base : voir [mot de passe admin](mot-de-passe-admin.md), étape 2.)

Puis, dans Admin → Réglages → E-mail, le bouton « Envoyer le test » :
il dit si le fournisseur accepte le message et, sinon, pourquoi.

## 2. Diagnostiquer

| Constat | Cause probable | Remède |
|---|---|---|
| e-mail de test refusé, « unauthorized » | clé Resend révoquée ou expirée | nouvelle clé dans Admin → Réglages → E-mail, champ « Clé d'API Resend » |
| test accepté, rien n'arrive | domaine d'envoi non vérifié, SPF ou DKIM cassé après un changement DNS | Resend → Domains : revérifier, corriger les enregistrements |
| rebonds en série dans Resend | adresses invalides, ou réputation du domaine | ne rien renvoyer en masse ; examiner les rebonds un par un |
| lignes `pending` qui ne bougent pas | le balayage ne tourne pas : aucune commande n'a encore enregistré `store_url`, ou le cron est désactivé | une commande réelle l'enregistre ; vérifier les déclencheurs du Worker |
| lignes `dead` | cinq échecs consécutifs | corriger la cause, puis les remettre en file (étape 3) |

## 3. Remettre en file

Une fois la cause corrigée, et seulement alors — sans quoi elles repartent
`dead` aussitôt :

```sh
npx wrangler d1 execute minshop-<slug>-production-db --remote --command \
  "UPDATE order_notifications SET state = 'pending', attempts = 0, lease_expires_at = NULL WHERE state = 'dead'"
```

Le balayage suivant les reprend. Chaque reçu part avec une clé d'idempotence
(`customer-receipt/<commande>`), que le fournisseur utilise pour écarter un
doublon envoyé de près.

## 4. Après

Une note dans le registre d'incidents : période, nombre de messages en retard,
cause. Si des clients ont attendu longtemps une confirmation de paiement, le
commerçant peut leur écrire ; les commandes, elles, sont toutes là.
