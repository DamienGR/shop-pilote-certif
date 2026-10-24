# Étape 10 — Argent réel

Passée dans la nuit du 24 au 25 octobre 2026 selon la fiche
`docs/certification/etape-10-commandes.md` du socle. Le pilote est monté de
`v0.3.20` en `v0.3.22` (pull request #30, CI 20/20) et la production de B
redéployée ; une clé Stripe live restreinte et le secret de son webhook sont
entrés dans le coffre de la production ; « Article de certification », à 1 €,
a été acheté avec une vraie carte, relevé de Stripe à l'e-mail, remboursé
depuis l'administration ; puis les clés ont été retirées et le produit
désactivé.

Les commandes ont été lancées par l'agent ; Damien a fusionné la montée,
déclenché et approuvé le déploiement, et fait à la main ce qui passe par un
tableau de bord ou un navigateur : Stripe, Réglages, le produit, l'achat, le
remboursement, la lecture des e-mails. Les heures sont celles de Paris
(UTC+2).

## Ce qui coche le plan

| Ligne du plan | Preuve | Résultat |
|---|---|---|
| clés Stripe live et secret du webhook live dans le coffre de la production | `cle-test-refusee.png`, `cle-live.png`, `commande.json`, `porte-distante.txt` | la clé `rk_test_…` refusée (« Clé de test refusée : cette boutique est la production… »), rien d'enregistré ; puis « En service — mode live : paiements réels » ; une session `cs_live_…` ; la porte distante 14/14 avec Stripe configuré, « aucun champ de carte » |
| un produit à 1 € ; commande réelle | `produit.json`, `commande.json`, `stripe-paiement.png` | 100 centimes, stock 1, expédié, 50 g ; la commande `tspzkyxggc` payée 6,90 € sur `pi_3UUD0xPDgQeHL5O710WjEFP1` |
| cohérence relevée entre Stripe, D1, stock, administration et e-mail | `commande.json`, `lignes.json`, `notifications.json`, `stock-apres-commande.json`, `fiche-epuisee.txt`, `admin-commande.png`, `stripe-paiement.png` | 690, dont 590 de Colissimo et 115 de TVA à 20 %, `tax_cents` et remise à 0, conditions version 1 ; le même `pi_…` dans Stripe et en base ; le stock à 0, la fiche « Épuisé » ; la confirmation envoyée. **L'alerte du commerçant a été sautée** (défaut 3) |
| remboursement total ; la commande, le stock et l'e-mail suivent | `commande-remboursee.json`, `remboursements.json`, `evenements-remboursement.json`, `stock-apres-remboursement.json` | `refunded`, 690 par le prestataire, 0 en externe, aucune revue ; un remboursement `provider_sync` de 690 ; un `charge.refunded` traité, livré en 200 ; le stock reste à 0, voulu ; un seul e-mail de remboursement |
| e-mails lus dans Gmail, Outlook et Apple Mail | `emails/` | Gmail : la confirmation et le remboursement. Outlook et Apple Mail : **dérogation** (ci-dessous) |
| le reçu de Stripe décidé avec le commerçant | ce README | « Paiements réussis » coupé : l'acheteur ne reçoit que la confirmation de la boutique, qui porte la TVA |
| clés live retirées, ou boutique laissée fermée | `cles-apres.json`, `panier-ferme.txt`, `commandes-apres.json`, `produit-apres.json` | aucune clé Stripe en base ; le panier dit la commande « momentanément indisponible » ; une seule commande, la nôtre ; le produit inactif |

## Le déploiement

| Run | Date (UTC) | Socle | Archive préalable | Fumée |
|---|---|---|---|---|
| 40133545202 | 2026-10-24 21:17 → 21:26 | `v0.3.22` | `pilote-certif-production-20261024T212535Z` (10 fichiers) | 5/5 au premier essai, aucun avertissement ; aucun secret créé |

`provision.json` : le `provision --env production` du poste, qui rend la
configuration de production sans rien créer, `MINSHOP_ENV` à `production`.

## Ce qui ne laisse pas de fichier

- **La fenêtre** : les clés enregistrées à 23 h 56 (`settings`, 21:56:11 UTC),
  retirées à 0 h 20 : 24 minutes. Aucune autre commande pendant la fenêtre
  (`commandes-avant.json` : 0, `commandes-apres.json` : 1).
- **Le paiement** : à 0 h 02, carte Visa standard de l'EEE. La page de Stripe
  en `cs_live_`, en français, sans bandeau de test, 1,00 € + Colissimo 5,90 €
  = 6,90 €.
- **3-D Secure** : non exercé. Stripe a appliqué l'exemption d'authentification
  forte (montant faible), visible sur `stripe-paiement.png`.
- **Frais et net** : 0,27 € de frais, 6,63 € de net. Le remboursement rend les
  6,90 € à la carte ; les frais restent dus.
- **Le remboursement** : par le bouton « Rembourser 6,90 € via le
  prestataire » de l'administration, « Réussi » dans Stripe avant la fermeture
  de la fenêtre. L'heure exacte n'a pas été relevée, ni un passage par « En
  attente ».
- **Le reçu de Stripe** : « Paiements réussis » coupé avant le paiement ;
  aucun reçu de Stripe dans Gmail. Chaque commerçant reprend la décision dans
  sa checklist de lancement.
- **Moyens de paiement Stripe** : la carte seule. Aucun moyen différé, donc
  pas de commande en attente.
- **Les messageries** : dans Gmail, la confirmation (« Votre commande Certif
  Minshop n°tspzkyxggc », 1,00 €, livraison 5,90 €, total 6,90 €, « dont TVA
  (20 %) : 1,15 € », « Voir ma commande ») et le remboursement (« Remboursé :
  6,90 € ») sont arrivés en boîte de réception, expédiés par
  `commandes@certif-minshop.miijot.fr`, accents et liens corrects. L'e-mail
  d'abord pris pour l'alerte dans Outlook était un e-mail de Stripe.

## Dérogations

- **Outlook** : aucun e-mail de la boutique n'y est arrivé, puisque l'alerte a
  été sautée (défaut 3). Un second achat aurait fermé la ligne pour 0,27 € de
  frais de plus ; Damien a préféré ne pas le faire. Le numéro de l'alerte
  (`v0.3.22`) reste prouvé par la répétition en conteneur et par les tests du
  socle, pas par un e-mail réel.
- **Apple Mail** : aucun appareil Apple à disposition, comme pour l'achat sur
  Safari de l'étape 6.

## Défauts et écarts

1. **`core upgrade` lit l'état du clone avant d'en récupérer les tags.** Ce
   clone n'avait que les tags jusqu'à `v0.3.5` : la montée a annoncé
   « v0.3.5 → v0.3.22 », 283 fichiers divergents et la migration 0045, déjà
   appliquée. La fusion était juste, puisque git suit le graphe et pas les
   tags. Le corps de la pull request #30 a été réécrit à la main depuis
   `v0.3.20`. Corrigé dans le socle, `v0.3.23`.
2. **Réglages cache la raison d'un refus.** Avec JavaScript, l'enregistrement
   part en arrière-plan ; le serveur répond 400 avec « Clé de test
   refusée : … », et la page affiche « Échec de l'enregistrement —
   réessayez ». C'est vrai pour tous les refus de Réglages, depuis la
   première version ; la répétition ne l'avait vu que sans JavaScript. La
   capture `cle-test-refusee.png` a été prise JavaScript coupé pour le site.
   Corrigé dans le socle, `v0.3.23`.
3. **La production n'avait pas de destinataire d'alertes.** Aucune fiche de
   l'étape 9 ne demandait de remplir Réglages → E-mail → « Destinataire des
   alertes de commande », et le socle n'a pas d'adresse par défaut :
   l'alerte de `tspzkyxggc` est `skipped`, et aucun moyen ne la renvoie.
   L'adresse Outlook est posée depuis 0 h 15. À reprendre dans la checklist
   de lancement, et à signaler dans l'administration.
4. **Le bandeau « Aucun moyen de paiement réel n'est configuré »** dit que la
   commande de démonstration permet de commander. En production, la
   démonstration est coupée : personne ne peut commander. Le bandeau ne lit
   que l'absence d'un moyen réel.
5. **La fiche d'un produit désactivé reste servie** en 200 par son URL directe,
   « Épuisé » ; le panier, lui, le refuse. À décider dans le socle : une page
   qui reste, ou un 404.
6. **Une lecture D1 a échoué en 7403** (« The given account is not valid… »),
   comme à l'étape 9 ; relancée, elle est passée.

## Ce qui reste

- Défauts 1 et 2 : publier `v0.3.23` et monter le pilote.
- Défauts 3 à 5 : à corriger dans le socle ou dans la checklist de lancement.
- Les clés : retirées jusqu'à l'étape 11, qui décide de l'ouverture. Les
  remettre prend une nouvelle clé restreinte et le même secret de webhook ;
  l'endpoint « pilote-certif production » est gardé.
