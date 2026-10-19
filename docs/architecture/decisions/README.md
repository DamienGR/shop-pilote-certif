# Décisions d'architecture

Ce répertoire contient les ADR (Architecture Decision Records) du socle
`minshop-platform`. Un ADR enregistre une décision structurante, son contexte
et ses conséquences, afin qu'une boutique créée dans un an puisse être exploitée
sans reconstituer le raisonnement d'origine.

## Règles

- un ADR est immuable une fois accepté ; une décision qui change fait l'objet
  d'un nouvel ADR qui remplace le précédent (`Remplace` / `Remplacé par`) ;
- la numérotation est séquentielle et ne se réutilise jamais ;
- un ADR décrit une décision, pas une procédure : les procédures vivent dans
  le plan d'implémentation et les runbooks ;
- toute modification du cœur qui contredit un ADR accepté doit d'abord
  proposer l'ADR qui le remplace.

Utiliser [`0000-template.md`](0000-template.md) pour un nouvel ADR.

## Index

| ADR | Titre | Statut |
|---|---|---|
| [0001](0001-modele-isolation.md) | Modèle d'isolation des boutiques | Accepté |
| [0002](0002-propriete-des-comptes.md) | Propriété des comptes et des fournisseurs | Accepté |
| [0003](0003-versionnement-du-socle.md) | Versionnement du socle et stratégie Git | Accepté |
| [0004](0004-localisation-des-donnees.md) | Localisation des données | Accepté |
| [0005](0005-strategie-de-sauvegarde.md) | Stratégie de sauvegarde et de restauration | Accepté |
| [0006](0006-politique-des-migrations.md) | Politique des migrations de schéma | Accepté |
| [0007](0007-perimetre-fonctionnel.md) | Périmètre fonctionnel de l'offre | Accepté |
| [0008](0008-format-du-manifeste-client.md) | Format et autorité du manifeste client | Accepté |
| [0009](0009-forme-de-la-cli-shopctl.md) | Forme, langage et livraison de la CLI `shopctl` | Accepté |
| [0010](0010-tva-facturation-et-consentement.md) | TVA, facturation et consentement aux CGV | Accepté, sous réserve |
| [0011](0011-langue-de-l-administration.md) | Langue de l'administration | Remplacé par 0018 |
| [0012](0012-identite-du-catalogue-importe.md) | Identité du catalogue importé | Accepté |
| [0013](0013-environnements-de-deploiement.md) | Environnements de déploiement | Accepté |
| [0014](0014-automatisation-de-la-forge.md) | Automatisation de la forge | Accepté |
| [0015](0015-cycle-de-vie-d-une-boutique.md) | Cycle de vie d'une boutique, de la construction à la livraison | Accepté |
| [0016](0016-registre-et-mise-a-niveau-de-la-flotte.md) | Registre de flotte et forme d'une mise à niveau | Accepté |
| [0017](0017-effacement-et-portabilite.md) | Effacement et portabilité des données d'un acheteur | Accepté |
| [0018](0018-administration-en-francais.md) | L'administration en français | Accepté |
