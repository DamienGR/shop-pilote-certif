# Procédure — rembourser une commande

Un remboursement est une décision du commerçant (rétractation, colis perdu,
article défectueux, geste commercial) ; la boutique l'exécute ou
l'enregistre. Elle a été suivie telle quelle en mode test (étape 4 de la
certification) puis en argent réel (étape 10, commande `tspzkyxggc`).

Trois règles valent pour tous les cas :

- **l'argent part du prestataire, jamais de la boutique.** La boutique demande
  le remboursement à Stripe ou le recopie ; elle ne détient aucun moyen de
  rendre de l'argent par elle-même ;
- **un remboursement ne remet rien en stock.** Le colis peut être parti. Si
  l'article revient, remettre son stock à la main dans Admin → Produits ;
- **les frais du prestataire ne reviennent pas.** Stripe garde ceux du
  paiement initial ; c'est un coût du commerçant, à prévoir dans ses CGV et
  ses prix.

## 1. Remboursement total d'une commande Stripe

Depuis la commande, dans Admin → Commandes :

1. ouvrir la commande et vérifier le montant affiché dans « Reste
   remboursable » ;
2. **Rembourser … via le prestataire**, et confirmer. La boutique demande le
   remboursement à Stripe avec la clé du coffre, puis l'enregistre aussitôt :
   la commande passe en « Remboursée » et l'acheteur reçoit l'e-mail de
   remboursement ;
3. l'événement `charge.refunded` que Stripe envoie ensuite ne change rien : un
   seul remboursement, un seul e-mail.

Attendu : dans Stripe, le paiement marqué remboursé ; dans la commande, le
total remboursé égal au total payé. Les fonds arrivent sur la carte de
l'acheteur dans le délai de sa banque (souvent cinq à dix jours ouvrés), que
la boutique ne raccourcit pas.

## 2. Remboursement partiel

Le bouton de l'administration ne rembourse que le reste entier. Pour une
partie (un article sur deux, les frais de port seuls) :

1. dans le tableau de bord Stripe, ouvrir le paiement (le même `pi_…` que la
   commande) et **Rembourser**, avec le montant voulu ;
2. la boutique reçoit `charge.refunded` et met la commande à jour : «
   Partiellement remboursée », le montant remboursé et le reste ; l'acheteur
   reçoit l'e-mail de remboursement.

Un second remboursement partiel suit le même chemin ; le total ne peut
dépasser le montant payé.

## 3. Ce qui n'est pas apparu dans la boutique

Si un remboursement fait dans Stripe ne s'affiche pas dans la commande après
quelques minutes :

- Admin → Commandes affiche en tête « remboursements à traiter » quand Stripe
  a signalé un remboursement que la boutique n'a pas pu rattacher (devise
  différente, total qui dépasserait celui de la commande, paiement inconnu) :
  **Réessayer** une fois la cause comprise, ou **Classer** ;
- si Stripe n'a pas livré l'événement, suivre le runbook
  [webhooks-stripe](runbooks/webhooks-stripe.md) ; en dernier recours, dans la
  commande, **Synchroniser un remboursement depuis votre prestataire** avec le
  **total** remboursé à ce jour chez Stripe, pas le dernier montant seul.

## 4. Un remboursement fait hors de Stripe

Paiement Lightning, virement, avoir remis en main propre : la boutique ne
déplace pas l'argent. Rembourser d'abord par le moyen utilisé, puis dans la
commande **Enregistrer un remboursement déjà effectué**, avec le montant et
une note interne qui dit comment il a été fait. **Annuler** un enregistrement
erroné corrige les registres de la boutique ; aucun argent ne bouge.

## 5. Rétractation

Le droit de rétractation est celui que décrit la page « Droit de
rétractation » de la boutique, et son texte est sous la responsabilité du
commerçant ([responsabilités](responsabilites.md)). Le code de la
consommation (article L221-24) lui donne quatorze jours, à compter du moment
où il est informé de la décision de l'acheteur, pour rembourser, frais de
livraison standard compris ; il peut différer jusqu'à la récupération du bien
ou la preuve de son expédition. La boutique ne compte pas ce délai : le
commerçant le tient.

## 6. Ce qui reste

Chaque remboursement est dans l'export des commandes (Admin → Commandes →
Exporter en CSV) : ce que le prestataire a rendu, ce qui a été rendu hors de
lui, le net et la TVA d'origine. C'est ce que le comptable lit ; la boutique n'émet pas d'avoir numéroté tant que la stratégie
de facturation est `pending-validation`
([ADR 0010](../architecture/decisions/0010-tva-facturation-et-consentement.md)).
