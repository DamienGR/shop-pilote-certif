# Étape 4 — Fonctionnel et paiement en mode test

Passée le 2026-10-14 sur le staging de `pilote-certif` (compte A, `v0.3.3`),
selon la fiche `docs/certification/etape-4-commandes.md` du socle. Stripe en
mode test, e-mails réels vers une boîte de test.

## Commandes

|     | Commande         | `pi_…`                        | Montant Stripe | Où         | Ce qui a été vu                                                                                                                                                                                               |
| --- | ---------------- | ----------------------------- | -------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | `ord_698h2df82g` | `pi_3UQP53PDgQeHL5O71pALdWaI` | 23,90 €        | ordinateur | confirmation et alerte ; webhook renvoyé sans seconde commande ; remboursements de 5,00 € puis 18,90 €, un e-mail chacun ; `charge.refunded` renvoyé sans effet                                               |
| B   | `ord_hpxcw4mvpf` | `pi_3UQP7kPDgQeHL5O72Q4kltQa` | 44,06 €        | ordinateur | `CERTIF10` : remise de 4,24 € sur les articles, TVA 7,34 € sur le total remisé ; confirmation et alerte ; e-mail d'expédition avec le numéro de suivi                                                         |
| C   | `ord_dwj27r6xzr` | `pi_3UQPB2PDgQeHL5O70EHxECmJ` | 63,00 €        | téléphone  | trois options de livraison, l'option gratuite choisie ; 3-D Secure complété ; confirmation et alerte                                                                                                          |
| D   | `ord_t9n590hkaf` | `pi_3UQQr2PDgQeHL5O70hR2plvk` | 13,40 €        | ordinateur | clé Resend révoquée : commande écrite, aucun e-mail, notifications en échec 401 ; nouvelle clé collée à 12:03 UTC, les deux e-mails partis à 12:06 UTC, deuxième tentative ; e-mail de test des réglages vert |

Parcours du §8.1 fait sur ordinateur et sur téléphone : catalogue, recherche,
catégories, variantes et produits épuisés, panier, administration. Pages
légales publiées et au pied de page, case CGV « Version 1 » au panier, refus
côté serveur sans la case. Pagination vue avec cinq produits de plus, puis
retirée.

## Fichiers

| Fichier                                            | Section de la fiche                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `identifiants-publics-check.txt`                   | 2 — `backfill-public-ids.mjs --check` après le contournement ci-dessous |
| `stock-avant.json`                                 | 0 — stock du catalogue témoin avant les commandes                       |
| `stock-apres-commandes.json`                       | 3 — un de moins par article commandé                                    |
| `une-commande-par-session.json`                    | 4 — webhook rejoué, `n` à 1 partout                                     |
| `remboursements.json`                              | 5 — remboursement partiel puis total, puis rejoué                       |
| `resend-en-panne.json`                             | 7 — clé révoquée : notifications en `pending`                           |
| `resend-rattrape.json`                             | 7 — nouvelle clé : notifications en `sent`                              |
| `export-commandes.csv`                             | 8 — export de l'administration, e-mail masqué                           |
| `pagination.csv`                                   | 9 — cinq produits ajoutés puis désactivés                               |
| `pagination-ajout.json`, `pagination-retrait.json` | 9 — rapports de `catalog import`                                        |
| `commandes.json`                                   | 10 — les quatre commandes en base                                       |
| `stock-fin.json`                                   | 10 — stock en fin d'étape                                               |

## Défauts trouvés en réel

1. **Pages légales sans identifiant public.** La migration `0040` insère les
   quatre pages après `0033`, sans `public_id`, et rien ne lance
   `scripts/backfill-public-ids.mjs` : l'administration les liait à
   `/admin/pages/null/edit`, impossibles à publier. Contourné par
   `backfill-public-ids.mjs --remote` sur la base de staging, qui n'a rempli
   que ces quatre lignes.
2. **Case CGV répétée sur `/express`** : une par moyen de paiement, chaque
   formulaire portant la sienne. Le panier n'en montre qu'une.
3. **Paiement de démonstration offert à côté de Stripe.** `enabledMethods`
   l'ajoute tant qu'il n'est pas désactivé : n'importe quel visiteur passe une
   commande sans payer, stock décrémenté. Désactivé dans les réglages de la
   boutique ; c'est la cause du doublon du point 2 sur cette boutique.
4. **Transporteurs américains seulement** (USPS, UPS, FedEx, DHL, Other), quand
   les tarifs par défaut s'appellent Colissimo. B expédiée avec « Other », sans
   lien de suivi.

Ces défauts sont corrigés dans le socle et livrés par une montée de version.

## Défauts connus de `v0.3.3`, corrigés en `v0.3.4`

- l'option gratuite s'appelle « Free shipping » (commande C) ;
- la version texte des e-mails de commande omet la TVA ;
- une page publiée n'entre pas seule dans le pied de page (menu, voulu).

## Observations

- Les images des e-mails ne s'affichent pas : elles sont servies par la
  preview, derrière Access, qui répond par sa page de connexion. Attendu sur
  le staging ; à vérifier en production à l'étape 9. L'écharpe, sans image au
  catalogue témoin, porte l'image de remplacement.
- Numéro de suivi saisi avec un zéro de plus que la fiche (`6A000000000000`),
  fictif dans les deux cas.
