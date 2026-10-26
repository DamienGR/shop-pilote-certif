# Étape 11 — Validations humaines et décision

Passée du 25 au 27 octobre 2026 selon la fiche
`docs/certification/etape-11-commandes.md` du socle, et le dossier de décision
`docs/certification/dossier-de-decision.md` qu'elle remplit. Le pilote est
monté en `v0.3.26` (pull request #37), en `v0.3.27` (#40), puis en `v0.3.28`
(#42), chaque fois redéployé sur B ; les CGV sont passées en version 2 (#39) ; les quatre pages
légales ont été écrites en entier et saisies dans l'administration.

Le pilote est une **boutique de démonstration** : il sert à éprouver le
parcours de certification, et son vendeur est fictif. Ses pages légales le
disent en tête, et l'identité qu'elles donnent l'est aussi (« Camille Exemple
(personne fictive) », SIREN 000 000 000, adresses en `.invalid`). De là
viennent trois des décisions de Damien : la relecture juridique, la
validation comptable et la recette par une personne extérieure attendent la
première boutique réelle.

Les commandes ont été lancées par l'agent ; Damien a fusionné les pull
requests, publié les versions du socle, déclenché et approuvé les
déploiements, et saisi les pages. Les heures sont en UTC.

## Ce qui coche le plan

| Ligne du plan | Preuve | Résultat |
|---|---|---|
| relecture des pages légales et du consentement aux CGV | `pages-avant.txt`, `pages-apres.txt`, `pages.json` | 14, 9, 5 et 4 lignes à marqueur avant ; 0 après, 200 partout ; les textes en ligne identiques aux projets ; les CGV en version 2 (#39). La relecture par un conseil : **dérogation** |
| validation TVA et facturation par un expert-comptable | ce README | **dérogation** : `invoiceStrategy` reste `pending-validation` ; le courrier et ses cinq questions sont prêts, hors du dépôt |
| recette par une personne extérieure | ce README, le dossier (section 5) | **dérogation** : chaque scénario du modèle joué par les étapes 4 à 11, scénario par scénario dans le dossier |
| documentation du §12 complète | le dossier, section 4 | (à venir) |
| rapports assemblés, dérogations signées | le dossier, sections 2 et 3 | (à venir) |
| décision go/no-go (point F) | le dossier, section 6 | (à venir) |

## Les déploiements

| Run | Socle | Archive préalable | Fumée |
|---|---|---|---|
| 40236611288 | `v0.3.26` | `pilote-certif-production-20261025T214858Z` | au premier essai ; aucun secret créé |
| 40352733778 | `v0.3.27` | `pilote-certif-production-20261026T161114Z` | au premier essai ; aucun secret créé |
| 40365454643 | `v0.3.28` | `pilote-certif-production-20261026T173810Z` | au premier essai ; aucun secret créé |

Les rapports sont dans `deploy-v0.3.26/`, `deploy-v0.3.27/` et
`deploy-v0.3.28/`. Le deuxième déploiement porte aussi les CGV en version 2,
fusionnées avant lui. Le troisième applique la migration 0046, qui ne
réécrit qu'un squelette encore marqué : relu avant lui, aucune page de la
production ne l'était, et les quatre textes sont restés tels quels, date de
modification comprise.

## Le nocturne

`nocturne.txt` : le run 40237706569, lancé à la main le 2026-10-25 après le
premier déploiement, vert en entier, audit des dépendances compris (rouge les
24 et 25 octobre, avant `v0.3.26`). Le staging est sauté : il est détruit
depuis l'étape 9.

La ligne RPO : (à venir) le premier run de l'après-midi, à 15:17 UTC, que
`v0.3.27` ajoute. La montée a été fusionnée à 15:46 le 26, après le créneau de
ce jour-là.

## Ce qui ne laisse pas de fichier

- **La saisie des pages**, par Damien, dans Admin → Pages : de 14:20 à 14:23
  le 26, puis de nouveau de 16:14 à 16:15. Les CGV avaient d'abord été collées
  depuis l'affichage Markdown mis en forme du Bloc-notes, qui avait échappé
  leur syntaxe : « \*\*Boutique de démonstration.\*\* » et un « --- » se
  lisaient sur la page. Les quatre textes ont été recollés depuis une copie
  `.txt`.
- **Le double titre** : la page affiche son titre, et chaque texte commençait
  par `# <titre>`, comme les squelettes de la migration 0040. La ligne a été
  retirée des quatre textes avant la seconde saisie ; un seul `<h1>` par page
  depuis.
- **« Version 2 »** ne se voit pas dans le panier : aucune clé de paiement
  n'est en place, et le panier dit la commande « momentanément indisponible »
  au lieu de proposer la case. La version vit dans `src/store.config.ts`, et la
  prochaine commande la portera.
- **`pages.json`** contient le texte des pages. Les seules adresses
  électroniques qu'il porte sont les adresses fictives des textes, en
  `.invalid`.

## Les défauts trouvés

1. `core upgrade` s'arrêtait sur un conflit dans `wrangler.jsonc`, fichier
   généré, à la montée en `v0.3.26` ; résolu à la main, puis par le socle en
   `v0.3.27`.
2. La montée reprise annonçait « v0.3.26 → v0.3.26 » : elle lisait son point
   de départ dans le dernier tag local ; corrigé en `v0.3.27`.
3. La meta description d'une page collait les mots de part et d'autre d'un
   saut de ligne (« parcours decertification ») ; les descriptions de produit
   aussi. Corrigé en `v0.3.28` : les quatre pages de la production disent
   « parcours de certification » depuis son déploiement.
4. Les squelettes des pages légales répétaient le titre de la page. Corrigé
   en `v0.3.28` (migration 0046) pour les boutiques à venir ; le pilote
   l'avait déjà retiré de ses textes.

## Les décisions

Prises par Damien, écrites dans la section 5 du dossier :

1. le CPU reste au plan gratuit de Workers, sous dérogation ;
2. le RPO est tenu par une seconde sauvegarde quotidienne de la production
   (`v0.3.27`) ;
3. l'échec réseau temporaire est tenu par les preuves des étapes ;
4. la relecture juridique et la validation comptable attendent la première
   boutique réelle, sous dérogation ;
5. la recette du pilote est tenue par les preuves des étapes, la personne
   extérieure attendant la recette de livraison de la première boutique
   réelle, sous dérogation.

La décision du point F : (à venir).
