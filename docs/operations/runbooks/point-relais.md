# Runbook — un point relais fait défaut

**Déclencheurs** : le tarif relais n'apparaît plus à la commande ; la fiche
commande dit que Boxtal refuse le point à l'achat de l'étiquette ; un acheteur
signale un point fermé, un colis jamais arrivé ou pas retiré ; le suivi
montre un retour à l'expéditeur ; Boxtal ne répond plus.

**Ce qu'il faut savoir** ([ADR 0020](../../architecture/decisions/0020-expeditions-par-boxtal.md),
[ADR 0021](../../architecture/decisions/0021-boxtal-apres-le-bac-a-sable.md)) :

- la commande garde une **copie** du point choisi (offre, code, nom, adresse) :
  Boxtal ne relit pas un point par son code. La boutique ne change pas de point
  après la commande, et ses e-mails nomment toujours celui-là ;
- une recherche de points qui échoue **retire le tarif relais du choix** sans
  bloquer la commande : l'acheteur voit les tarifs à domicile. Une recherche
  réussie sert une heure depuis le cache ;
- la boutique ne suit pas le colis après son numéro : son état est sur la page
  du transporteur (le lien de l'e-mail d'expédition) et dans l'espace Boxtal ;
- un numéro de suivi Mondial Relay **saisi à la main** part sans lien : son
  URL porte un code de l'expéditeur que la boutique ne connaît pas. Seule une
  étiquette achetée depuis la boutique garde l'URL que Boxtal rend.

## 1. Le tarif relais a disparu de la commande

Une adresse qu'aucun réseau ne sert (un code postal sans point) le retire
sans erreur, et c'est voulu. S'il disparaît pour toutes les adresses :

- Admin → Réglages → Étiquettes de transport (Boxtal) : les clés de l'API v3
  sont là, et l'environnement est celui des clés (des clés du bac à sable en
  « Production » répondent 401) ;
- Admin → Livraison : le tarif relais est dans la zone du pays, avec son offre ;
- les journaux du Worker, pendant une commande d'essai :

```sh
npx wrangler tail minshop-<slug>-production --format json | grep relay_points_unavailable
```

| `relay_points_unavailable` | Sens | Remède |
|---|---|---|
| aucune ligne, et pas de tarif relais | la recherche a répondu sans point, ou le tarif n'est pas proposé | vérifier l'adresse, le tarif et les clés |
| `uncertain` à `true` | Boxtal ne répond pas, ou répond en 5xx | attendre : les commandes continuent à domicile. Une panne longue se dit au commerçant |
| `uncertain` à `false` | Boxtal refuse : clés révoquées ou retirées, offre fermée sur le compte | refaire les clés dans l'espace Boxtal et les saisir dans Réglages ; une offre fermée se remplace dans Livraison |

La ligne nomme l'offre, jamais l'adresse de l'acheteur.

## 2. Boxtal refuse le point à l'achat de l'étiquette

La fiche dit : « … Prévenez l'acheteur, achetez l'étiquette dans Boxtal vers
un point voisin, puis saisissez le suivi à la main. » Le point a fermé, ou ne
prend plus de colis, depuis la commande.

1. Écrire à l'acheteur (l'e-mail est sur la fiche) : le point de sa commande
   ne prend plus de colis, et un ou deux points voisins du même réseau, à
   choisir. Lui dire que l'e-mail d'expédition nommera encore l'ancien point,
   et que celui de ce message fait foi.
2. Dans l'espace Boxtal du commerçant, créer l'envoi vers le point retenu, sur
   la même offre.
3. Sur la fiche commande : **Marquer comme expédiée**, le transporteur et le
   numéro. L'e-mail d'expédition part, sans lien pour Mondial Relay ; ajouter
   le lien de la page de suivi dans un message à l'acheteur si besoin.

Sans réponse de l'acheteur, ou s'il préfère : **rembourser** depuis la fiche
([remboursement](../remboursement.md)) plutôt qu'expédier vers un point qu'il
n'a pas choisi.

## 3. Le colis n'est pas retiré, ou revient

Le transporteur garde le colis au point le temps de son délai de garde, puis
le renvoie à l'expéditeur ; l'avis de mise à disposition et le délai partent
vers l'acheteur, par SMS ou par e-mail. Le délai de Mondial Relay est relevé
par la commande réelle de la campagne des points relais
([fiche, B7](../../certification/points-relais-commandes.md#b7-le-dépôt-puis-le-retrait-quelques-jours)).

- **Avant la fin du délai** : la page de suivi dit « disponible au point ».
  Rappeler l'avis à l'acheteur.
- **Le colis revient** (retour à l'expéditeur, dans l'espace Boxtal et sur
  la page de suivi) : écrire à l'acheteur. Réexpédier, c'est un nouvel envoi dans l'espace Boxtal, puis
  sur la fiche **Marquer comme non expédiée** et **Marquer comme expédiée** avec
  le nouveau numéro ; ou rembourser. Qui paie le retour et la réexpédition, ce
  sont les CGV du commerçant qui le disent. Un remboursement ne remet rien en
  stock : remettre l'article à la main quand il est revenu.

## 4. Le colis n'arrive pas au point

La page de suivi s'arrête, ou montre une anomalie. Le transporteur peut
réacheminer le colis vers un point voisin : sa page le dit, et l'avis à
l'acheteur aussi. Au-delà de son délai d'acheminement
annoncé, ouvrir une réclamation dans l'espace Boxtal, qui la porte chez le
transporteur, et tenir l'acheteur au courant. Un colis perdu se rembourse à
l'acheteur depuis la fiche ; l'indemnisation du transporteur suit, à part.

## 5. Boxtal en panne

La recherche échoue (§1) : les commandes continuent à domicile, rien à faire
dans la boutique. L'achat d'une étiquette échoue ou reste incertain : ne pas
insister, [etiquette-incertaine](etiquette-incertaine.md). Une commande en
relais déjà payée attend son étiquette : l'acheter quand Boxtal revient, ou
depuis l'espace Boxtal et saisir le numéro à la main (§2, étape 3).

## 6. Après

Une note dans le registre d'incidents : commande (identifiant public), réseau,
ce qui a fait défaut (recherche, point refusé, non retiré, retour, perte), la
voie choisie et ce qu'elle a coûté. Plusieurs points refusés sur un même
réseau en peu de temps se disent au commerçant : ce réseau peut sortir de
Livraison.
