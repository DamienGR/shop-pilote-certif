# Modèle — recette et procès-verbal de livraison

La recette est faite par **une personne extérieure au développement**, sur
l'interface qui sera livrée ([ADR 0018](../architecture/decisions/0018-administration-en-francais.md)),
avec ce seul document en main : si un scénario demande une explication orale,
c'est une anomalie de la boutique ou de ce modèle, et elle se note. Le
procès-verbal qui la clôt est signé du commerçant et de l'agence ; il marque
la livraison.

Une recette par boutique, à sa mise en ligne. Les scénarios suivent le §8.1
du [plan d'implémentation](../implementation-plan.md) ; une ligne qui ne
s'applique pas (pas de variantes, pas de code promotionnel) se marque « sans
objet », jamais « OK ».

## Avant la séance

L'agence prépare, et le note en tête du procès-verbal :

- [ ] l'URL de la boutique, la version du socle (`npm run shopctl -- core
  status`) et le dernier nocturne vert ;
- [ ] le moyen de payer : un vrai paiement de petit montant remboursé ensuite
  en production, ou Stripe en mode test sur une preview. Le choix est celui du
  commerçant ; les frais d'un vrai paiement ne sont pas rendus ;
- [ ] un produit de recette (prix bas, stock 2, une photo), à désactiver à la
  fin, et un code promotionnel créé dans Stripe si la boutique en accepte
  (`features.promoCodes`) ;
- [ ] l'accès à l'administration : le commerçant se connecte lui-même devant
  la personne, ou lui confie le mot de passe pour la séance et le change
  ensuite (`npm run shopctl -- admin password --env <env>`) ;
- [ ] une adresse e-mail de la personne pour recevoir les e-mails de
  commande ; sa commande reste dans la comptabilité de la boutique.

## Scénarios

Chaque ligne reçoit **OK**, **KO** (avec le numéro de l'anomalie) ou **sans
objet**. Une capture accompagne chaque KO.

### Vitrine, comme un acheteur, sur ordinateur

| # | Scénario | Attendu | Résultat |
|---|---|---|---|
| V1 | ouvrir l'accueil, une catégorie, une fiche produit | photos, prix TTC, description lisibles | |
| V2 | chercher un produit par un mot de sa description | il est dans les résultats | |
| V3 | sur une fiche à variantes, changer de taille ou de couleur | le prix et la disponibilité suivent | |
| V4 | ajouter deux articles au panier, changer une quantité, en retirer un | le total suit, sans recharger à la main | |
| V5 | ajouter plus que le stock d'un article | la boutique refuse et dit pourquoi | |
| V6 | choisir la livraison | les frais et le délai annoncés apparaissent avant de payer | |
| V7 | tenter de payer sans cocher l'acceptation des CGV, puis en la cochant | refus, puis la page de paiement ; le lien des CGV ouvre le bon texte | |
| V8 | sur la page de paiement, saisir un faux code promotionnel, puis le vrai | refus lisible, puis la remise sur le total | |
| V9 | payer | page de confirmation avec le numéro de commande | |
| V10 | lire l'e-mail de confirmation | articles, livraison, total, TVA, adresse ; aucun mot anglais ni caractère cassé | |
| V11 | ouvrir chaque page du pied de page | mentions légales, CGV, confidentialité, rétractation : complètes, sans « [À COMPLÉTER] » | |

### Vitrine, sur téléphone

| # | Scénario | Attendu | Résultat |
|---|---|---|---|
| T1 | refaire V1, V4 et V6 sur un téléphone | rien ne déborde de l'écran, les boutons se touchent sans zoomer | |
| T2 | ouvrir le menu, revenir à l'accueil | navigation sans impasse | |

### Administration, comme le commerçant

| # | Scénario | Attendu | Résultat |
|---|---|---|---|
| A1 | se connecter, se déconnecter | tableau de bord en français | |
| A2 | lire l'alerte « Nouvelle commande » reçue pour V9 | même numéro que celui du client | |
| A3 | ouvrir la commande de V9, la marquer expédiée avec un numéro de suivi | l'acheteur reçoit l'e-mail d'expédition | |
| A4 | rembourser la commande ([procédure](remboursement.md)) | statut « Remboursée », e-mail de remboursement reçu | |
| A5 | exporter les commandes en CSV et l'ouvrir dans un tableur | la commande, sa TVA, son remboursement | |
| A6 | créer un produit avec une photo, le publier, le voir en vitrine | il apparaît dans sa catégorie | |
| A7 | mettre son stock à 0, puis le désactiver | « Épuisé », puis la fiche disparaît | |
| A8 | modifier une page de contenu, la prévisualiser, l'enregistrer | le texte change en vitrine | |
| A9 | ajouter une page au menu du pied de page (Admin → Navigation) | elle y apparaît sans déploiement | |

### Ce que la personne en dit

Trois questions, réponses libres : qu'est-ce qui a été difficile à trouver ?
Qu'est-ce qui a surpris ? Qu'est-ce qui manquerait pour tenir la boutique seul ?

## Anomalies

| N° | Scénario | Description | Gravité | Suite |
|---|---|---|---|---|
| | | | | |

Gravité : **bloquante** (empêche de vendre, d'encaisser, de rembourser, ou
expose une donnée), **majeure** (un scénario échoue, un contournement existe),
**mineure** (forme, libellé). Une anomalie bloquante empêche la livraison ;
une majeure la permet sous réserve, avec un délai de correction.

## Procès-verbal de livraison

**Boutique** : ____________  **URL** : ____________
**Version du socle** : v______  **Date de la recette** : ____________

**Personne qui a fait la recette** (extérieure au développement) :
____________

**Résultat** : ___ scénarios OK, ___ KO, ___ sans objet ;
anomalies bloquantes ___, majeures ___, mineures ___.

**Remis au commerçant** :

- [ ] le dépôt de la boutique, ou l'accès à celui-ci ;
- [ ] la [matrice des responsabilités](responsabilites.md) et la liste des
  [sous-traitants](sous-traitants.md) ;
- [ ] les procédures d'exploitation de ce dossier, dont le
  [remboursement](remboursement.md) ;
- [ ] les dérogations encore ouvertes, chacune datée et signée.

**Le commerçant confirme** que les textes des pages légales, les prix, la TVA
appliquée et la stratégie de facturation sont les siens et restent sous sa
responsabilité.

**Décision** :

- [ ] livrée sans réserve ;
- [ ] livrée avec réserves : ____________ (correction avant le ____________) ;
- [ ] refusée : ____________.

| | Nom | Date | Signature |
|---|---|---|---|
| Pour le commerçant | | | |
| Pour l'agence | | | |
