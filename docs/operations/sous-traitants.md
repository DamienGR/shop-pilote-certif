# Sous-traitants techniques d'une boutique

La liste de ce qui reçoit des données d'une boutique, pour le registre des
traitements du commerçant, sa politique de confidentialité et l'annexe du
contrat de sous-traitance avec l'agence (RGPD, article 28). Le commerçant est
responsable du traitement ; l'agence est sous-traitante. Stripe, Resend et les
fournisseurs optionnels le sont de lui directement, puisque ces comptes sont à
son nom ([ADR 0002](../architecture/decisions/0002-propriete-des-comptes.md)).

**Cloudflare dépend du compte qui héberge la boutique.** Sur le compte
mutualisé de l'agence ([ADR 0019](../architecture/decisions/0019-compte-cloudflare-mutualise.md)),
le cas de toute nouvelle boutique, Cloudflare est un **sous-traitant
ultérieur de l'agence** (article 28, paragraphes 2 et 4) : le contrat avec le
commerçant doit l'autoriser par écrit, l'agence lui impose les mêmes
obligations par le DPA de Cloudflare qu'elle accepte pour son compte, et elle
informe le commerçant de tout changement de ce sous-traitant ultérieur, qui
peut s'y opposer. Une boutique restée sur le compte Cloudflare du commerçant
(le pilote, avant sa migration) garde Cloudflare comme sous-traitant direct du
commerçant.

Elle se tient à jour **par boutique** : une ligne optionnelle n'y figure que
si le commerçant l'a activée. La dernière colonne est à vérifier sur le
contrat de traitement (DPA) que chaque fournisseur publie, le jour où il est
signé : ce document ne le remplace pas.

## Toujours présents

| Fournisseur | Rôle | Données personnelles reçues | Où elles sont stockées | Garanties de transfert |
|---|---|---|---|---|
| Cloudflare (Workers, D1, R2, KV, Turnstile, Cloudflare for SaaS) | hébergement de la boutique, de sa base, de ses images et fichiers, des sessions d'administration, des sauvegardes ; protection anti-robots des formulaires ; certificat et routage du domaine du commerçant sur le compte mutualisé | toutes celles de la boutique : e-mail, nom et adresse de livraison des acheteurs, commandes, adresse IP dans les journaux ; le jeton du widget Turnstile | base et buckets créés en juridiction `eu` et vérifiés au provisioning ([ADR 0004](../architecture/decisions/0004-localisation-des-donnees.md)) ; l'exécution du Worker et les journaux d'Observability sont distribués sur le réseau mondial | DPA de Cloudflare, à vérifier ; accepté par l'agence sur le compte mutualisé, par le commerçant sur son propre compte |
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

- **GitHub** : le dépôt de la boutique, sa CI et ses preuves de certification,
  et, sur le compte mutualisé, le dépôt de flotte de l'agence qui déploie et
  sauvegarde. Aucune donnée d'acheteur n'y entre : les sauvegardes vont dans le
  bucket R2 de la boutique, jamais dans un artefact, et les preuves sont relues
  avant d'être versées ([plan de certification, §3](../certification/plan.md)).
  Un dépôt public publie en revanche le manifeste, l'historique et les adresses
  des auteurs de commits ;
- **Coinbase** : le cours du bitcoin, lu sans rien envoyer, pour les paiements
  Lightning ;
- **les polices** : servies par la boutique elle-même ; la vitrine ne charge
  rien d'un autre domaine que le sien et celui de ses images.

## Ce que le compte mutualisé partage

Chaque boutique garde sa base, ses buckets, son Worker et ses secrets : rien de
ce qu'elle stocke n'est lisible par une autre (ADR 0001). Ce qui est commun aux
boutiques du compte, et que la politique de confidentialité n'a pas à détailler
mais que l'agence doit pouvoir décrire sur demande :

- les jetons API du compte, dans le seul dépôt de flotte de l'agence, jamais
  dans le dépôt d'une boutique ;
- les journaux d'Observability du compte, filtrés par Worker ;
- la zone SaaS de l'agence, qui porte les certificats des domaines des
  commerçants ;
- un widget Turnstile pour dix noms d'hôte au plus.

La mention « Hébergeur » des pages légales nomme toujours Cloudflare ; sur le
compte mutualisé, elle est à faire relire par le conseil du commerçant, puisque
le contrat d'hébergement est celui de l'agence.

## Quand la liste change

Un nouvel adaptateur (un port du socle : paiement, e-mail, stockage,
recherche, étiquettes) ajoute une ligne ici dans la même pull request. Le
commerçant en est informé avant de l'activer : son registre et sa politique
de confidentialité le nomment.
