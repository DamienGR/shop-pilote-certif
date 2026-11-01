# ADR 0007 — Périmètre fonctionnel de l'offre

- **Statut** : Accepté ; amendé pour les points relais par
  l'[ADR 0020](0020-expeditions-par-boxtal.md)
- **Date** : 2026-08-28
- **Jalon** : 0

## Contexte

Le socle Minshop amont couvre plus que ce que le pilote entend vendre :
paiement Lightning (phoenixd, LNbits, OpenNode), serveur MCP pour agents,
recherche sémantique (Workers AI + Vectorize), produits numériques, comptes
clients. Chaque fonctionnalité conservée doit être testée, documentée,
supportée et maintenue à jour sur toute la flotte.

L'offre visée est étroite et assumée : petites boutiques B2C françaises, moins
de 100 produits, paiement par carte, livraison simple.

## Décision

Le périmètre commercialisé du pilote est **B2C France** : locale `fr-FR`,
fuseau `Europe/Paris`, devise EUR, prix TTC, checkout invité, produits simples
et à variantes, stock, catégories et recherche FTS, Stripe Checkout, livraison
fixe / au poids / franco, codes promotionnels Stripe, e-mails de confirmation
et d'expédition, pages éditoriales et légales, export des commandes,
sauvegarde et restauration, administration protégée par Cloudflare Access et
Turnstile.

Sont **hors périmètre** : multilingue, multidevise, abonnements, marketplace,
B2B avancé, points relais, tarifs transporteur temps réel, synchronisation ERP
ou comptable, automatisation marketing, personnalisation produit complexe,
recherche sémantique, Lightning, OpenNode et MCP.

Le code amont correspondant n'est **pas supprimé** du socle : il reste présent,
désactivé par défaut par la configuration, et n'est ni activé, ni certifié, ni
supporté dans l'offre. Une fonctionnalité hors périmètre activée pour un client
sort du contrat de support standard et exige une décision explicite.

## Conséquences

- la campagne de certification (section 8 du plan) porte sur un périmètre fini,
  ce qui la rend exécutable pour chaque nouvelle boutique ;
- conserver le code amont désactivé garde les mises à jour du socle fusionnables
  sans conflit et laisse la porte ouverte à une extension ultérieure ;
- le coût est un socle plus gros que l'offre : des modules non certifiés
  restent dans l'arbre, et la CI doit continuer à les construire
  (`npm run verify` couvre le Worker MCP) ;
- toute demande client hors périmètre est un avenant, pas une option de
  configuration ;
- la frontière doit être vérifiable : un défaut de configuration qui activerait
  Lightning ou MCP sur une boutique du pilote doit échouer au contrôle, pas
  passer inaperçu.

## Alternatives écartées

- **Supprimer le code hors périmètre du socle** : rendrait chaque mise à jour
  amont conflictuelle et fermerait définitivement des extensions dont la valeur
  commerciale n'est pas encore tranchée.
- **Vendre tout ce que le socle sait faire** : multiplie la surface à certifier,
  à documenter et à supporter, pour des fonctionnalités qu'aucune boutique du
  pilote ne demande.

## Vérification

- le manifeste `client/client.yaml` déclare les fonctionnalités actives et
  refuse un champ inconnu (jalon 1) ;
- la boutique témoin `canary-minimal` construit le socle avec le minimum
  fonctionnel ;
- la campagne de la section 8 ne couvre que le périmètre inclus ; toute
  dérogation est écrite, datée et compensée.
