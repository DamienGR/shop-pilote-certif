# Runbook — Stripe ne livre plus les webhooks

**Déclencheurs** : des paiements visibles dans Stripe sans commande dans
l'admin ; un client payé qui n'a reçu ni confirmation ni page de commande ; des
produits qui restent « épuisés » alors que personne n'a payé ; une alerte
« webhook endpoint failing » de Stripe.

**Ce qu'il faut savoir** : une commande n'existe qu'une fois payée
(invariant 2), et elle n'est écrite **que** par un webhook signé
(`/api/webhook`, ou `/api/webhook/stripe`). Pendant le paiement, le stock est
tenu par une réservation : trente minutes, plus cinq de grâce, libérée par
l'événement `checkout.session.expired`. Sans webhooks, rien n'est perdu chez
Stripe, mais rien n'arrive dans la boutique — ni les commandes, ni la
libération du stock.

## 1. Constater

Dans le tableau de bord Stripe, mode **live** ou **test** selon la boutique :
Développeurs → Webhooks → l'endpoint `https://<domaine>/api/webhook`.

- tentatives en **400** : la signature est refusée. Le secret de signature de
  l'endpoint ne correspond plus à `stripe_webhook_secret` (rotation, endpoint
  recréé, clé test au lieu de live) ;
- tentatives en **5xx** ou délai dépassé : le Worker est en cause, voir
  [Worker en erreur](worker-en-erreur.md) ;
- **aucune tentative** : l'endpoint est désactivé, pointe sur un autre domaine,
  ou n'est pas abonné aux événements attendus. Il en faut cinq :
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`.

## 2. Réparer

- **signature** : sur l'endpoint Stripe, révéler le secret de signature et le
  saisir dans Admin → Réglages → Paiements → Carte (Stripe), champ « Secret de
  signature du webhook » (`stripe_webhook_secret`). Ne pas
  « faire tourner » le secret pour l'occasion : chaque rotation recrée le
  problème tant que la saisie n'a pas suivi ;
- **endpoint** : le recréer avec l'URL de production et les cinq événements,
  puis saisir son nouveau secret.

## 3. Rattraper

Stripe relance automatiquement un événement refusé, avec un délai croissant,
pendant plusieurs jours en mode live : une fois le secret corrigé, la plupart
des commandes arrivent seules. Pour ne pas attendre, renvoyer chaque événement
en échec depuis la page de l'endpoint.

Le traitement est idempotent : un événement reçu deux fois ne crée pas deux
commandes. Une commande dont la réservation a expiré entre-temps est quand
même enregistrée, et porte le manque de stock si un autre client a pris
l'article : à traiter avec le client (livraison différée ou remboursement).

## 4. Vérifier

- chaque paiement réussi de la période a sa commande dans l'admin (comparer
  les identifiants de session Stripe) ;
- le stock tenu par des réservations expirées est revenu (le balayage
  planifié des réservations tourne toutes les cinq minutes pour les rails
  sans webhook ; pour Stripe, c'est l'événement `expired` qui libère) ;
- les e-mails de confirmation sont partis : voir [e-mails bloqués](emails-bloques.md).

## 5. Après

Une note dans le registre d'incidents : période sans webhooks, nombre de
commandes rattrapées, clients contactés.
