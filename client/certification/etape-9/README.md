# Étape 9 — Bascule sur le compte client

Passée du 2026-10-21 au 2026-10-23 selon la fiche
`docs/certification/etape-9-commandes.md` du socle. La production de
`pilote-certif` est créée sur le compte B (« Miijot », `b8505b29…`) et sert
`certif-minshop.miijot.fr`. Le staging du compte A (`e11ea775…`) est détruit.
Stripe en mode test pour les achats sur le staging ; la production n'a aucun
moyen de paiement jusqu'à l'étape 10.

Le pilote est monté de `v0.3.12` en `v0.3.18` pendant l'étape, en quatre
versions du socle publiées chacune avant la section qu'elle protégeait (pull
requests #21, #23, #25 et #26, CI verte à chaque fois) ; le domaine d'images
est déclaré dans le manifeste par la pull request #24.

Les commandes ont été préparées et lancées par l'agent depuis des scripts qui
reprennent la fiche. Damien a approuvé chaque déploiement de production dans
GitHub et suivi les runs avec un script, le mode automatique refusant à
l'agent de lire un run de `Deploy` ; il a déclenché lui-même les deux derniers,
que le mode automatique refusait aussi de lancer.
Il a fait à la main ce qui passe par un tableau de bord : jetons, widget
Turnstile, clé Resend, domaine d'images, installation et réglages de
l'administration, vidage des buckets, nettoyage final.

## Ce qui coche le plan

| Ligne du plan | Preuve | Résultat |
|---|---|---|
| `provision --env production` sur B, que le manifeste nomme | `provision-simulation.json`, `provision.json`, `provision-2.json`, `provision-3.json` | Miijot (B) ; base et trois buckets en `eu`, vérifiés un par un ; 46 migrations ; démonstration coupée ; le domaine d'images vu au second passage |
| contenus saisis sur B, pas recopiés depuis A | `catalogue-simulation.json`, `catalogue-1.json`, `catalogue-2.json` | 20 produits, 9 variantes, 4 catégories, 8 médias importés sur B ; le second import ne change rien ; réglages et pages légales saisis dans l'administration de B ; aucune restauration depuis A |
| `deploy --env production` par `Deploy`, sauvegarde préalable verte, approbation GitHub | `deploy-1/` à `deploy-4/`, `apres-deploy-*.txt` | quatre runs approuvés, une archive préalable envoyée à chaque fois (ci-dessous) |
| domaine de production, domaine d'images, smoke test public vert | `deploy-2/…/deploy.json`, `servie.txt` | fumée 5/5 sans avertissement aux trois derniers runs ; l'image en `200 image/png` servie par `images-certif-minshop.miijot.fr` |
| la porte distante contre la production, `--limiteurs` | `porte-distante.txt` | 17 contrôles, 0 en échec ; la connexion en 429 au plus tard à la sixième tentative |
| `shopctl destroy --env staging` sur A | `destroy-simulation.json`, `destroy-1.json`, `destroy-2.json`, `destroy-apres.txt`, `nocturne-2.txt` | staging parti ; le nocturne le dit et sauvegarde la production |

Au-delà des lignes : `admin-password.json` et `apres-deploy-1.txt`
(l'assistant jamais ouvert au public), `nocturne-1/`, `pull-production.json`
et `verify-production.json` (le RPO tenu sans staging), `repo.json`,
`cle-pull.json` et `cle-verify.json` (la clé de sauvegarde éprouvée avant la
production).

## Les déploiements de production

| Run | Date (UTC) | Socle | Archive préalable | Fumée |
|---|---|---|---|---|
| 39649979500 | 2026-10-21 18:17 | `v0.3.16` | `pilote-certif-production-20261021T181716Z` (2 fichiers, base vide) | `AUTH_SECRET` et `SECRETS_KEK` créés ; trois avertissements « pas encore installée », attendus avant l'assistant |
| 39662509456 | 2026-10-21 19:41 | `v0.3.16` | `pilote-certif-production-20261021T194104Z` (10 fichiers) | 5/5, aucun avertissement |
| 39796895935 | 2026-10-22 15:01 | `v0.3.17` | `pilote-certif-production-20261022T150146Z` (10 fichiers) | 5/5 |
| 39930175090 | 2026-10-23 09:24 | `v0.3.18` | `pilote-certif-production-20261023T092443Z` (10 fichiers) | 5/5 ; l'accueil dit « Boutique », « Tous les produits », « Votre panier », plus aucun libellé anglais |

Après le premier run, `/admin/setup` répond 303 vers `/admin/login` : le mot
de passe posé à la section 5 (`admin-password.json`, 18:08) a gardé
l'assistant fermé au public, alors que la base était neuve.

## Ce qui ne laisse pas de fichier

- **Premier déploiement** : run 39649979500, archive préalable à 18:17 UTC le
  2026-10-21 ; **porte distante** : 19:44 UTC le même soir.
- **Premier certificat** : le domaine d'images attaché au bucket de B était
  `pending` à 17:54:40 UTC, `active` à 18:01:37, soit moins de sept minutes.
  Le domaine de production répondait en HTTPS dès le premier contrôle après le
  déploiement ; son délai propre n'a pas été mesuré.
- **E-mail de test** : envoyé depuis Réglages → E-mail de B, avec la clé
  Resend de production et l'expéditeur `commandes@certif-minshop.miijot.fr`
  du domaine vérifié ; reçu (le défaut 6 de l'étape 8 est fermé).
- **Turnstile** : le widget vu sur la page de connexion de B.
- **Champs de clé** : vides après l'enregistrement des réglages, le navigateur
  n'y verse plus le mot de passe (`v0.3.16`).
- **Après la destruction** : `preview.studiomaestro.fr` ne résout plus du
  tout ; le domaine personnalisé du Worker est parti avec lui, et son
  enregistrement DNS aussi. Le dépôt ne garde que les environnements `backup`
  et `production`, `STAGING_RETIRED` vaut 2026-10-23.
- **Nettoyage à la main**, fait par Damien le 2026-10-23 : le jeton de staging
  révoqué sur A, les deux applications Access de la preview et les jetons de
  service « pilote-certif » supprimés, l'endpoint de webhook Stripe test de la
  preview supprimé, la clé Resend du staging révoquée.

## Les achats de l'étape 6

Repassés sur le staging avant sa destruction ; le tableau est aussi reporté
dans `../etape-6/README.md`.

| Navigateur | Version | Commande | Ce qui a accroché |
|---|---|---|---|
| Chrome, poste (étape 6) | non relevée | #6 `ord_r0rgn4xrwc` | rien de signalé |
| Firefox, poste | non relevée | non relevée | la quantité tapée sans « Mettre à jour » perdue au paiement (`v0.3.17`) |
| Chrome Android, premier passage (`v0.3.16`) | non relevée | non relevée | le menu ouvert hors de l'écran ; « Rechercher » et « Panier » coupaient le nom de la boutique ; la quantité perdue (`v0.3.17`) |
| Chrome Android, après `v0.3.17` | 155.0.8059.84 | `g984x8qpm2` | rien : deux porte-clés, la quantité tapée sans « Mettre à jour », 35,90 € dont 5,98 € de TVA ; menu, icônes et tiroir corrects ; e-mail reçu ; capture `achats/chrome-android-g984x8qpm2.jpg`, l'adresse masquée |
| Safari, iPhone | | | **non fait** : aucun iPhone à disposition |

Les versions et numéros manquants n'ont pas été relevés au moment des achats,
et le staging qui les portait est détruit.

## Sauvegarde et nuit

`cle-pull.json` et `cle-verify.json` : avant de toucher B, la clé de
sauvegarde du poste a rouvert l'archive de staging
`pilote-certif-staging-20261021T084158Z`.

Nocturne 39664391888 (`nocturne-1/`) : six jobs verts, la production
sauvegardée par son propre job (`pilote-certif-production-20261021T194618Z`).
Cette archive, rapatriée sur le poste (`pull-production.json`) et relue
(`verify-production.json`) : taille, empreinte et huit objets identiques,
26 tables, aucun échec. La copie locale a été supprimée ensuite.

Nocturne 39981389480 (`nocturne-2.txt`), après la destruction : job `Staging`
sauté avec la notice « Staging détruit le 2026-10-23 », `Production backup` et
`Production error rate and quotas` verts.

## La destruction du staging

La simulation liste six ressources, sur A. Le premier passage sort en 6 :
Worker, namespace des sessions et bucket de fichiers partis ; R2 refuse les
buckets d'images et de sauvegardes (10008) et nomme Settings → Empty Bucket ;
la base gardée. Après le vidage des deux buckets dans le tableau de bord de A,
le second passage sort en 0 : les deux buckets, puis la base.

## Défauts et écarts

1. **Le nom de la boutique ne vient pas du manifeste.**
   `wrangler.template.jsonc` porte `STORE_NAME: "Ma boutique"` en dur, et
   `client.displayName` n'y arrive jamais : l'assistant de B a proposé « Ma
   boutique ». Corrigé à la main dans Réglages. Le staging avait le même nom
   (visible sur la capture). À corriger dans le socle.
2. **Le premier déploiement du staging en `v0.3.15` a échoué** sur
   `d1 migrations apply` (7403, « The given account is not valid… »),
   `deploy-staging-v0.3.15-1.json` ; relancé avec `--skip-verify`, il est
   passé sans rien changer. Erreur passagère de l'API.
3. **Trois trous de la fiche**, corrigés dans la fiche de `v0.3.17` : `gh`
   refusait de choisir entre les deux remotes du clone ; `catalog import`
   sortait en 4 après le `git restore wrangler.jsonc` de la section 6, faute de
   configuration rendue ; le contrôle du panier lisait un panier vide.
4. **La fiche ne demande pas de révoquer la clé Resend du staging.** Révoquée
   quand même.
5. **Le mot de passe du staging est parti chez Resend** avant `v0.3.16` (le
   navigateur l'avait versé dans le champ de clé, Resend a répondu 400). Il ne
   protégeait que le staging, détruit depuis ; la production a son propre mot
   de passe, posé à la section 5.
6. **Le nocturne nomme mal le job sauté** : `Staging
   (${{ needs.detect.outputs.shop }})`. Et GitHub signale que
   `actions/upload-artifact@v4` tourne sur Node 20, déprécié. À corriger dans
   le socle.
7. **Les achats** : la ligne de Safari reste ouverte, et des versions et
   numéros manquent (ci-dessus).

## Ce qui reste

- Défauts 1 et 6 : à corriger dans le socle, dans une version suivante ; 4 :
  à ajouter à la fiche.
- Stripe live, et le reçu de Stripe à décider pour le commerçant : étape 10.
