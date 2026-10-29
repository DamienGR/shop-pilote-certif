# Certifier une boutique : le parcours court

La campagne du pilote (du 6 au 27 octobre 2026, [plan](plan.md)) a certifié
**le socle** : le parcours d'achat, le stock, l'isolation, la sécurité, la
restauration, ce que la décision du 2026-10-27 a accepté sous conditions. Une
boutique de plus ne la rejoue pas. Elle prouve qu'elle porte un socle certifié
sans l'avoir modifié, passe `shopctl certify`, et consigne quatre gestes
humains. Cible : une heure à une heure et demie de manuel pour l'agence, la
recette chez le commerçant.

Ce parcours est d'après le pilote : il ne fait avancer aucun des jalons 0 à 10,
clos avec la campagne ; il vient du §13 « Après le pilote » du plan
d'implémentation.

## Ce qu'une boutique hérite, et à quelle condition

Le socle reste certifié à chaque version : `npm run verify` à chaque commit,
la porte navigateur sur chaque thème, et `pilote-certif` montée à chaque tag
avec son nocturne. Une boutique hérite de tout cela tant que :

- elle porte un **tag publié du socle au moins égal à `v0.3.28`**, la version
  sur laquelle la campagne s'est close. Le plancher ne monte que pour une
  faille corrigée ;
- elle ne **diverge d'aucun fichier du socle**, ou chaque divergence est
  nommée et justifiée dans ses attestations (section `core`). Une divergence
  dans le paiement, le stock, l'authentification, les secrets ou une
  migration n'est jamais héritable : la modification rejoint le socle, ou la
  campagne se rejoue pour elle.

Les trois conditions du go restent dues par **la première boutique réelle**
avant sa première vente : relecture juridique des textes, réponse écrite de
l'expert-comptable, recette par une personne extérieure
([décision, §6](dossier-de-decision.md#6-décision-point-f)). Ensuite, le parcours des CGV est
acquis ; les textes et le régime de TVA restent ceux de chaque commerçant,
sous sa responsabilité ([matrice](../operations/responsabilites.md)).

## Le parcours

| # | Étape | Qui | Manuel agence |
|---|---|---|---|
| 0 | Prérequis : compte Cloudflare du client avec l'agence invitée, zone du domaine, Stripe live activé, domaine d'envoi vérifié chez Resend | commerçant | 0 |
| 1 | `shopctl new … --create-repo`, manifeste, `backup keygen`, `repo --reviewer` | agence | 10 min |
| 2 | Production sur le compte du client : jetons, `provision`, `admin password`, déploiement approuvé | agence | 20 min |
| 3 | Saisie : assistant, Réglages (expéditeur, alertes, Turnstile, Stripe live et webhook), catalogue, pages légales du commerçant | agence ou commerçant | 25 min |
| 4 | `shopctl certify --env production` | machine, 10 min environ | 0 |
| 5 | [Recette](../operations/recette.md) par le commerçant : achat réel remboursé, e-mails, téléphone, procès-verbal | commerçant | 0 |
| 6 | Attestations remplies, `certify --write`, rapport versé par une pull request de la boutique, fusion, ouverture | agence | 15 min |

Les étapes 1 à 3 sont la [mise en ligne](../operations/mise-en-ligne.md),
sans preview sur le compte de l'agence : la production se construit
directement sur le compte du client, fermée jusqu'à l'ouverture
([ADR 0015](../architecture/decisions/0015-cycle-de-vie-d-une-boutique.md),
amendé le 2026-10-27). Une preview reste possible ; elle coûte 45 min à
1 h de plus (Access, jeton de service, secrets du nocturne de staging, puis
destruction et révocations).

## `shopctl certify`

```sh
npm run shopctl -- certify --env production            # juge, n'écrit rien
npm run shopctl -- certify --env production --write    # et écrit le rapport
```

Lancée depuis l'arbre de la boutique, avec le jeton de production exporté
pour wrangler (`CLOUDFLARE_API_TOKEN`, sans écho) et `gh` authentifié. Elle
n'écrit sur aucun compte : `provision` y tourne en simulation, la base est lue
par un `SELECT` qui masque les secrets, le hachage du mot de passe et le
destinataire des alertes, et ne rend de l'expéditeur que son domaine.

| Groupe | Ce qu'elle juge | Par |
|---|---|---|
| Socle | tag publié ≥ `v0.3.28`, déclaré et fusionné ; aucun fichier du socle modifié sans déclaration ; aucun fichier de paiement, stock, authentification ou schéma modifié | `core status`, règles de propriété |
| Arbre | outillage, manifeste, propriété des chemins, aucun secret dans tout l'historique ; domaine réel ; `invoiceStrategy` sortie de `pending-validation` | `doctor`, `config validate`, `check:paths`, `check:secrets:history` |
| Compte | base et buckets présents, dans la juridiction ; fichiers et sauvegardes privés ; règle de conservation ; secrets internes du Worker | `provision --dry-run` |
| Base | assistant terminé, mot de passe posé ; Stripe dans le coffre et non coupé ; e-mails actifs, expéditeur hors `resend.dev`, destinataire des alertes ; Turnstile actif, avec une vraie clé | lecture D1 masquée |
| Vitrine publique | test de fumée ; vitrine indexable ; quatre pages légales publiées, complètes, au pied de page ; porte de sécurité distante ; porte navigateur distante ; Lighthouse mobile ≥ 90 (performance, accessibilité, SEO) sur l'accueil, une catégorie, une fiche et le panier, LCP, CLS et INP relevés | `test:security:remote`, `test:browser:remote`, API PageSpeed Insights |
| Dépôt | `production` avec relecteur ; `backup` limité à la branche par défaut ; secrets présents, par nom ; dernier déploiement de production vert ; sauvegarde vérifiée et surveillance (`monitor`) de la production vertes dans le nocturne depuis moins de 30 h | `gh` |
| Attestations | les six gestes humains, datés | `client/certification/attestations.yaml` |

Chaque ligne est verte (✓), un avertissement (!), un échec (✗), à attester
(·) ou sautée avec sa raison (-). **Certifiable** : aucun échec, rien à
attester, rien de sauté ; un avertissement se lit et ne bloque pas. Sinon,
code 6, et chaque ligne dit quoi faire.

- **Les limiteurs** ne sont pas dans le parcours : ils bloquent l'adresse de
  l'opérateur un quart d'heure sur l'administration, et le socle les prouve.
  `--rate-limits` les ajoute.
- **Lighthouse** passe par l'API PageSpeed Insights de Google, qui reçoit
  l'URL publique de la boutique. Elle demande en pratique `PAGESPEED_API_KEY`,
  une clé d'API Google gratuite, l'API PageSpeed Insights activée : sans clé,
  le quota est partagé par tous les appels anonymes, et il était épuisé dès le
  premier appel le 2026-10-27, depuis deux réseaux. Une API qui ne répond pas
  est un saut nommé, jamais un vert.
- **La porte navigateur** demande Playwright et Chromium sur le poste
  (`npm ci`, `npx playwright install chromium`). Sans eux, elle est sautée et
  la boutique n'est pas certifiée.
- **Le nocturne** doit avoir tourné : `gh workflow run nightly.yml` après le
  premier déploiement, si la nuit n'est pas encore passée.

## Les attestations

`certify --write` pose le modèle s'il manque. Une date (AAAA-MM-JJ) et une
référence par geste, **jamais une adresse e-mail ni un nom de client** : le
fichier est versionné, et toute valeur qui contient « @ » est refusée.

```yaml
purchase:
  date: 2026-11-04            # l'achat réel de la recette (V9)
  payment: pi_3Q…             # son identifiant Stripe
  refunded: 2026-11-04        # son remboursement (A4)
emails:
  date: 2026-11-04            # confirmation, alerte, expédition, remboursement (V10, A2 à A4)
  clients: "Gmail, Outlook"
phone:
  date: 2026-11-04            # T1, T2
  device: "iPhone 13, Safari"
acceptance:
  date: 2026-11-04            # le procès-verbal signé
  by: merchant                # ou delegate
legal:
  date: 2026-11-02            # les pages légales relues
  by: counsel                 # ou merchant, sous sa responsabilité
accounting:
  date: 2026-10-30            # la réponse de l'expert-comptable
  strategy: stripe-receipt    # = commerce.invoiceStrategy du manifeste
```

L'achat réel est celui de la recette : il prouve la configuration Stripe du
commerçant, et l'agence n'en fait pas un second. Une section `core`
(`divergences`, le nombre de fichiers, et `reason`) déclare les fichiers du
socle que la boutique modifie ; `certify` les recompte, et refuse un nombre
qui ne correspond plus.

## Ce qui ne se refait pas par boutique

Les répétitions en doublure, les fiches de commandes par étape, le dossier de
décision et les dérogations ; Stripe en mode test, la charge, la dernière
unité, le CPU, le retour arrière, la rotation des secrets, le mot de passe
perdu, l'effacement RGPD, la restauration chronométrée, la boutique canari ;
les quatre navigateurs à la main, remplacés par la porte navigateur et le
téléphone de la recette ; les preuves pièce par pièce, remplacées par un
rapport et un fichier d'attestations.

Le rapport (`client/certification/<date>/certify.json` et `certify.md`) et
les attestations entrent dans le dépôt de la boutique par une pull request.
Sa fusion vaut certification ; la boutique s'annonce ensuite.
