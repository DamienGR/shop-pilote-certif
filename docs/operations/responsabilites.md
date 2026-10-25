# Responsabilités de l'agence et du commerçant

Qui décide, qui fait, et qui répond, pour une boutique livrée par l'agence. Le
principe vient de l'[ADR 0002](../architecture/decisions/0002-propriete-des-comptes.md) :
le commerçant possède tous les comptes et vend en son nom ; l'agence construit
et exploite avec un accès délégué, nominatif et révocable. Ce document est
annexé au devis et au procès-verbal de livraison ([recette](recette.md)) ; une
ligne que le contrat change se change ici aussi.

## Ce que le commerçant porte seul

Ces lignes engagent le vendeur envers ses clients et l'administration.
L'agence fournit l'outil et des modèles ; elle ne rédige pas, ne valide pas et
ne signe pas à sa place.

| Sujet | Ce que fait le commerçant | Ce que fournit l'agence |
|---|---|---|
| Pages légales (CGV, mentions légales, confidentialité, rétractation) | rédige le texte définitif, le fait relire par un conseil compétent, le publie ; monte `legal.termsVersion` quand les CGV changent | des squelettes à compléter (migration 0040) ; une production refuse d'en publier un qui porte encore « [À COMPLÉTER] » (`v0.3.25`) |
| TVA et facturation | choisit son régime avec son expert-comptable, valide la ventilation et le reçu, déclare la TVA | un taux par boutique, la TVA extraite du total TTC, l'export des commandes ([ADR 0010](../architecture/decisions/0010-tva-facturation-et-consentement.md)) ; aucune facture numérotée tant que `invoiceStrategy` vaut `pending-validation` |
| Catalogue, prix, photos, stock | les saisit dans l'administration ou les fournit en CSV | l'import ([guide](../agents/catalogue.md)), le contrôle des colonnes |
| Encaissement | ouvre et active son compte Stripe, porte le contrat, les litiges et les frais | l'intégration, la saisie des clés dans le coffre, l'endpoint de webhook |
| Remboursements et rétractation | décide de chaque remboursement et tient le délai légal | le bouton de l'administration et la synchronisation avec Stripe ([procédure](remboursement.md)) |
| Expédition et service client | prépare les colis, répond aux acheteurs | les e-mails d'expédition, les étiquettes si une clé Shippo est saisie |
| Données personnelles | responsable du traitement : registre, politique de confidentialité, réponse aux demandes, notification d'une violation à la CNIL | sous-traitant : export et anonymisation d'une personne (`shopctl privacy`), alerte sans délai en cas de violation ([runbook](runbooks/violation-de-donnees.md)), liste des [sous-traitants](sous-traitants.md) |
| Comptes Cloudflare, Resend, domaine | les ouvre à son nom et les paie ; invite l'agence | la liste des droits à donner ([guide des comptes](../certification/comptes-et-acces.md)) |
| Passage au plan Workers Paid, Resend Pro | décide et paie quand le volume l'exige | l'alerte (`shopctl monitor`) et le chiffrage |

## Ce que l'agence porte

| Sujet | Ce que fait l'agence | Ce que fait le commerçant |
|---|---|---|
| Construction et thème | crée la boutique depuis un tag du socle, applique le thème, la provisionne | valide la preview privée, puis la recette |
| Mises à jour du socle | publie les versions, propose la montée par pull request, déploie après approbation | approuve la mise en production quand le contrat le prévoit |
| Sécurité de la plateforme | portes de sécurité à chaque commit, secrets tirés par boutique, audit des dépendances chaque nuit | garde son mot de passe d'administration, n'ajoute pas d'accès |
| Sauvegarde et restauration | sauvegarde chaque nuit et avant chaque déploiement, restaure en moins d'une heure ([runbook](runbooks/base-corrompue.md)) | conserve, s'il part, la clé de sauvegarde qui lui est remise |
| Supervision et incidents | lit le nocturne, suit les runbooks, tient le registre d'incidents | est prévenu de tout incident qui touche ses clients ou ses données |
| Départ | remet le dépôt et la clé, efface ses copies ([procédure](sortie-client.md)) | révoque les accès de l'agence |

## Ce qui reste partagé

- **Les accès** : l'agence n'utilise que des accès nominatifs que le
  commerçant lui a donnés ; le commerçant ne partage jamais un identifiant, il
  invite.
- **Les e-mails d'alerte** : le commerçant donne l'adresse qui reçoit les
  alertes de commande ; l'agence vérifie qu'elle est saisie avant d'ouvrir les
  paiements ([mise en ligne](mise-en-ligne.md)).
- **Les dérogations** : une ligne de certification non tenue est décrite par
  l'agence, avec sa mesure compensatoire ; elle n'est acceptée qu'une fois
  signée par le commerçant.
