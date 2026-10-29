# ADR 0002 — Propriété des comptes et des fournisseurs

- **Statut** : Accepté ; remplacé pour Cloudflare par
  l'[ADR 0019](0019-compte-cloudflare-mutualise.md)
- **Date** : 2026-08-28
- **Jalon** : 0

## Contexte

Une boutique dépend de comptes tiers : Cloudflare (Worker, D1, R2, domaine),
Stripe (encaissement), Resend (e-mails transactionnels) et le registrar du
domaine. Ces comptes portent des obligations qui ne sont pas transférables à
l'agence : le contrat d'acquisition Stripe engage le commerçant, les données
personnelles des acheteurs lui appartiennent, et la facturation émise l'est en
son nom.

Deux modèles s'opposent : l'agence détient les comptes et refacture, ou le
commerçant détient les comptes et délègue un accès à l'agence.

## Décision

**Le commerçant est propriétaire de tous les comptes fournisseurs** de sa
boutique : Cloudflare, Stripe, Resend et le nom de domaine sont ouverts à son
nom et facturés à lui.

L'agence intervient comme opérateur avec un accès délégué, nominatif et
révocable — invitation sur le compte Cloudflare, rôle restreint sur Stripe —
jamais par partage d'identifiants. Les secrets d'exploitation sont stockés dans
le magasin de secrets de la plateforme (Wrangler) ou dans le coffre chiffré en
D1 pour les clés fournisseurs gérées depuis l'administration ; ils ne
transitent jamais par le dépôt, par les arguments de commande ou par les
journaux.

La création des comptes, l'invitation des utilisateurs et l'activation de
Stripe restent des opérations humaines : la CLI les vérifie
(`shopctl doctor`), elle ne les exécute pas.

## Conséquences

- la sortie du client est propre par construction : révoquer l'accès de
  l'agence suffit, aucune migration de compte n'est nécessaire ;
- l'agence n'est pas dans le flux financier et n'a pas à porter la conformité
  KYC ni les litiges d'encaissement ;
- la mise en service dépend d'actions du client (ouverture des comptes,
  validation Stripe) : c'est une dépendance de planning à afficher dès le
  devis ;
- le provisioning doit vérifier le compte actif avant toute écriture ; un
  opérateur connecté au mauvais compte Cloudflare est un incident probable et
  doit être détecté, pas subi ;
- l'agence conserve son propre compte Cloudflare pour les environnements de
  démonstration et de test du socle, séparé de tout compte client.

## Alternatives écartées

- **Comptes détenus par l'agence, refacturés** : place l'agence en
  intermédiaire de paiement, crée un verrou commercial contraire à la promesse
  de réversibilité et complique la sortie du client.
- **Identifiants partagés** : rend l'audit impossible, empêche la révocation
  individuelle et transforme le départ d'un collaborateur en rotation
  générale de secrets.

## Vérification

- `shopctl doctor` liste les prérequis de comptes et échoue tant qu'ils ne sont
  pas satisfaits ;
- le provisioning compare `wrangler whoami` à l'account ID attendu par le
  manifeste et refuse de continuer en cas d'écart ;
- le scan de secrets (`npm run check:secrets`) échoue si un identifiant est
  commité.
