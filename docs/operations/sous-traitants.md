# Sous-traitants techniques d'une boutique

La liste de ce qui reçoit des données d'une boutique, pour le registre des
traitements du commerçant, sa politique de confidentialité et l'annexe du
contrat de sous-traitance avec l'agence (RGPD, article 28). Le commerçant est
responsable du traitement ; l'agence est sous-traitante, et les fournisseurs
ci-dessous le sont de lui directement, puisque chaque compte est à son nom
([ADR 0002](../architecture/decisions/0002-propriete-des-comptes.md)).

Elle se tient à jour **par boutique** : une ligne optionnelle n'y figure que
si le commerçant l'a activée. La dernière colonne est à vérifier sur le
contrat de traitement (DPA) que chaque fournisseur publie, le jour où il est
signé : ce document ne le remplace pas.

## Toujours présents

| Fournisseur | Rôle | Données personnelles reçues | Où elles sont stockées | Garanties de transfert |
|---|---|---|---|---|
| Cloudflare (Workers, D1, R2, KV, Turnstile) | hébergement de la boutique, de sa base, de ses images et fichiers, des sessions d'administration, des sauvegardes ; protection anti-robots des formulaires | toutes celles de la boutique : e-mail, nom et adresse de livraison des acheteurs, commandes, adresse IP dans les journaux ; le jeton du widget Turnstile | base et buckets créés en juridiction `eu` et vérifiés au provisioning ([ADR 0004](../architecture/decisions/0004-localisation-des-donnees.md)) ; l'exécution du Worker et les journaux d'Observability sont distribués sur le réseau mondial | DPA de Cloudflare, à vérifier |
| Stripe | encaissement, remboursements | e-mail, adresse de facturation et de livraison saisies sur sa page de paiement, données de carte (que la boutique ne voit jamais), montant et contenu de la commande | chez Stripe | DPA de Stripe, à vérifier |
| Resend | e-mails transactionnels (confirmation, expédition, remboursement, alerte au commerçant) | adresse e-mail du destinataire, contenu de l'e-mail : articles, montants, adresse de livraison | chez Resend | DPA de Resend, à vérifier |

## Selon la configuration

| Fournisseur | Activé par | Données personnelles reçues | Garanties de transfert |
|---|---|---|---|
| Cloudflare Access | la preview privée du staging (agence) | adresses e-mail des personnes admises à la preview | DPA de Cloudflare |
| Shippo | une clé dans Admin → Réglages, pour acheter des étiquettes | nom, adresse et téléphone de livraison, poids du colis | DPA de Shippo, à vérifier |
| OpenNode, ou le nœud Lightning du commerçant (phoenixd, LNbits) | Admin → Réglages → Paiements | montant de la facture, aucune identité | DPA d'OpenNode, à vérifier ; un nœud du commerçant n'est pas un sous-traitant |
| Workers AI et Vectorize (Cloudflare) | la recherche sémantique, binding ajouté à la main | textes du catalogue, aucune donnée d'acheteur | DPA de Cloudflare |

Le transporteur (Colissimo dans les tarifs par défaut) reçoit l'adresse du
colis par l'étiquette que le commerçant imprime : c'est un prestataire du
commerçant, pas de la boutique.

## Ce qui ne reçoit pas de données d'acheteur

- **GitHub** : le dépôt de la boutique, sa CI et ses preuves de certification.
  Aucune donnée d'acheteur n'y entre : les sauvegardes vont dans le bucket R2
  de la boutique, jamais dans un artefact, et les preuves sont relues avant
  d'être versées ([plan de certification, §3](../certification/plan.md)). Un
  dépôt public publie en revanche le manifeste, l'historique et les adresses
  des auteurs de commits ;
- **Coinbase** : le cours du bitcoin, lu sans rien envoyer, pour les paiements
  Lightning ;
- **les polices** : servies par la boutique elle-même ; la vitrine ne charge
  rien d'un autre domaine que le sien et celui de ses images.

## Quand la liste change

Un nouvel adaptateur (un port du socle : paiement, e-mail, stockage,
recherche, étiquettes) ajoute une ligne ici dans la même pull request. Le
commerçant en est informé avant de l'activer : son registre et sa politique
de confidentialité le nomment.
