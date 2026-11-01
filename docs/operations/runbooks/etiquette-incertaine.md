# Runbook — un achat d'étiquette Boxtal est incertain, ou en double

**Déclencheurs** : le bandeau « achat d'étiquette à régler » en tête de la
liste des commandes ; une fiche commande dont l'encadré orange dit que l'achat
« ne s'est pas terminé correctement » ; deux envois pour la même commande dans
l'espace Boxtal ; un prélèvement Boxtal plus élevé que les étiquettes de la
boutique.

**Ce qu'il faut savoir** ([ADR 0021](../../architecture/decisions/0021-boxtal-apres-le-bac-a-sable.md)) :

- Boxtal n'est pas idempotent et ne liste pas les envois : une réponse perdue
  (coupure réseau, erreur 5xx, réponse illisible) laisse l'achat `uncertain`.
  La boutique ne le rejoue jamais d'elle-même, puisqu'un second envoi serait
  un doublon payé ;
- un envoi reste dans cet état tant qu'un humain ne l'a pas réglé, et il bloque
  toute nouvelle étiquette pour la commande. Un achat parti depuis plus de deux
  minutes sans réponse est traité de la même façon ;
- chaque tentative porte une **référence** : l'identifiant public de la
  commande suivi de huit caractères (`ord_…-1a2b3c4d`). Boxtal la garde sur
  l'envoi, et sur son colis avec `-1` à la fin. La fiche commande l'affiche ;
- Boxtal prélève les envois après coup. Un envoi s'annule dans l'espace Boxtal
  tant que le transporteur n'a pas pris le colis ; après, Boxtal refuse, et
  l'envoi se paie.

## 1. Constater

La liste des commandes (Admin → Commandes) nomme chaque commande à régler. Sans
accès à l'administration :

```sh
CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler d1 execute minshop-<slug>-production-db --remote --command \
  "SELECT o.public_id, l.status, l.shipment_id AS reference, l.rate_id AS offre, l.error, l.updated_at
     FROM shipping_labels l JOIN orders o ON o.id = l.order_id
    WHERE l.status IN ('uncertain', 'purchasing')"
```

(Rendre d'abord la configuration de production si la commande refuse le nom
de la base : voir [mot de passe admin](mot-de-passe-admin.md), étape 2.)

## 2. Chercher l'envoi chez Boxtal

Dans l'espace Boxtal du commerçant, en bac à sable ou en production selon
Admin → Réglages → Étiquettes de transport, chercher l'envoi créé à l'heure de
la tentative (`updated_at`, en UTC), pour l'offre de la fiche, et dont la
référence est celle qu'affiche la fiche commande. Relever son identifiant, de
la forme `2610301632POFR56E7FR`.

## 3. Régler

| Ce que montre Boxtal | Que faire |
|---|---|
| un envoi porte la référence | coller son identifiant dans « Identifiant de l'envoi Boxtal », puis « Vérifier et enregistrer » |
| aucun envoi à cette heure-là | « Aucun envoi n'existe dans l'espace du prestataire ? », puis « J'accepte le risque — abandonner la tentative », et refaire l'étiquette |
| deux envois portent la référence | enregistrer l'un, annuler l'autre (étape 4) |

« Vérifier et enregistrer » relit l'envoi chez Boxtal et ne l'enregistre que
s'il existe, n'est pas annulé, est confirmé, et que son colis porte la
référence de cette tentative. Le numéro de suivi est alors posé sur la
commande, qui passe expédiée, et l'e-mail d'expédition part. Ses refus :

| Message | Sens | Remède |
|---|---|---|
| « Boxtal ne connaît pas l'envoi … » | identifiant mal copié, ou pris dans l'autre environnement | recopier depuis l'espace de l'environnement réglé |
| « L'envoi … est annulé chez Boxtal » | cet envoi ne partira pas | chercher un autre envoi ; à défaut, abandonner la tentative |
| « Boxtal n'a pas encore confirmé l'envoi … » | Boxtal confirme un envoi en moins d'une minute | réessayer une minute plus tard |
| « Le colis de l'envoi porte la référence … » | c'est l'envoi d'une autre tentative ou d'une autre commande | chercher celui qui porte la référence attendue |

Abandonner la tentative renonce à la garantie d'un achat unique : si l'envoi
existait, il n'est pas enregistré sur la commande et il se paie quand même.
L'historique des étiquettes de la fiche garde la trace de l'abandon.

## 4. Annuler un doublon

Un doublon se voit dans l'espace Boxtal : deux envois pour la même commande,
dont un seul est le numéro de suivi de la fiche (« Historique des
étiquettes » donne l'identifiant enregistré). Annuler l'autre dans l'espace
Boxtal **avant la prise en charge du colis**. Après, Boxtal refuse et il se
paie : le noter pour le rapprochement du prélèvement.

## 5. Après

Une note dans le registre d'incidents : commande (identifiant public),
référence, ce que montrait Boxtal, la voie choisie, un doublon annulé ou payé.
Plusieurs achats incertains rapprochés désignent une panne de Boxtal ou du
réseau : attendre qu'elle passe avant d'acheter d'autres étiquettes, ou les
faire depuis l'espace Boxtal et saisir le numéro de suivi à la main sur la
commande.
