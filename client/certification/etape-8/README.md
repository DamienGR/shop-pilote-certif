# Étape 8 — Exploitation et résilience

Passée le 2026-10-20 sur le staging de `pilote-certif` (compte A), monté de
`v0.3.9` en `v0.3.12`, et sur une production neuve du compte B (« Miijot »),
créée puis détruite dans l'après-midi, selon la fiche
`docs/certification/etape-8-commandes.md` du socle. Stripe en mode test, un
jeton de service Access « pilote-certif étape 8 » créé pour l'étape et révoqué
à la fin.

Les commandes ont été préparées et lues par l'agent ; celles qui écrivent sur
un compte (production de B, `AUTH_SECRET`, remise à zéro du mot de passe,
anonymisation, objet R2, seuil du monitor) ont été lancées par Damien depuis
des scripts qui reprennent la fiche, le mode automatique les refusant à
l'agent. Les rapports sont ceux que ces scripts ont écrits.

## Les lignes de l'étape

| Ligne | Preuve | Résultat |
|---|---|---|
| `backup keygen`, `--upload`, `pull` depuis un autre poste, `verify` | `keygen.json`, `backup.json`, `pull.json`, `verify.json` | `keygen` en 4, la clé gardée ; archive `pilote-certif-staging-20261020T135944Z` envoyée ; rapatriée dans un clone neuf avec la clé du coffre, « Archive complète et cohérente », 26 tables relues |
| restauration chronométrée sur B, < 60 minutes, table par table | `chrono.txt`, `provision-b.json`, `restore-b.json`, `deploy-b-*.json`, `coffre-b.txt`, `servie-b.txt` | **RTO 29 min 21 s**, deux incidents compris (ci-dessous) ; sur Miijot (B) ; 26 tables identiques à l'archive ; 8 images dans le bucket de B ; fumée verte |
| RPO ≤ 24 heures : trois nuits | `nocturnes.txt`, `nocturne-*/` | cinq nuits consécutives (16 au 20 octobre), sauvegarde et restauration en `success` ; les rapports des trois dernières |
| `monitor` contre la vraie API, seuil abaissé | `monitor.json`, `monitor-seuil-abaisse.json` | `0`, puis `6` avec les trois quotas en ✗ ; une fois le jeton complété (« Défauts » 4) |
| média supprimé à la main | `media-supprime.txt`, `media-nettoye.json` | fiche, catalogue, API en 200 ; l'image en `404 text/plain` ; aucune exception ; nettoyé |
| rollback vers la version précédente, puis retour | `deploiement-avant.json`, `deploy-v0.3.12.json`, `rollback.txt` | `rollbackTo` = la version qui servait ; elle à 100 %, puis `v0.3.12` à 100 %, vitrine et catalogue en 200 |
| rotation de `AUTH_SECRET` | `rotation-auth-secret.txt` | la session tombe (303), vitrine, catalogue, panier en 200 ; reconnexion |
| mot de passe perdu, selon le runbook | `mot-de-passe.txt` | assistant refermé, ancienne session tombée, nouvelle connexion ; secret du nocturne remplacé |
| `privacy export` puis `anonymize` | `privacy-*.json`, `privacy-lien-suivi.txt` | 6 lignes, puis plus rien sous l'adresse ; la commande garde montants et TVA |

La **preuve de restauration** que le plan attend est la section
« Restauration sur B » ci-dessous et ses rapports.

## La montée et le retour arrière

`socle/v0.3.12` fusionnée par la pull request #19 (CI 20/20), avec les notes
de `v0.3.10` à `v0.3.12`, aucune migration. `deploy-v0.3.12.json` : `ok`,
aucun secret créé, fumée arrêtée par Access (302). `rollbackTo` vaut
`00392f82…`, la version qui servait (le `v0.3.9` de l'étape 6, déployé le 19
à 18:30) et non plus `1c01f15c…` : le correctif 1 de `v0.3.12` tient en réel.

`rollback.txt` : `c87afb92` (`v0.3.12`) à 100 %, `00392f82` à 100 % en 200,
`c87afb92` de nouveau à 100 % en 200, en vingt secondes. Lancé hors d'un
terminal, wrangler a pris le message de `--message` et répondu seul « yes » à
sa confirmation (`rollback-wrangler.txt`) ; il n'a posé aucune question sur les
secrets (pas de 10220), aucun n'ayant changé entre les deux versions.

## Sauvegarde et second arbre

L'arbre du pilote sur ce poste est un clone refait après l'étape 2 : il
n'avait pas de `.shopctl/backup.key`, et `keygen` en aurait écrit une
nouvelle, différente de celle du nocturne. La clé a été reprise du coffre,
puis éprouvée sur l'archive du nocturne de la nuit
(`pilote-certif-staging-20261020T084056Z`, 26 tables, « complète et
cohérente ») avant toute écriture. Le coffre a rempli son office ; un clone
neuf ne la porte pas, et c'est ce que la ligne veut voir.

Le second arbre : un clone neuf dans un répertoire temporaire, sans
`.shopctl` ni `backups`, aucun compte épinglé, `SHOPCTL_BACKUP_KEY` collée
depuis le coffre. `pull` compare taille et empreinte du corps et les huit
objets ; `verify` ouvre le corps et relit les 26 tables. Le second arbre a été
supprimé à la fin de la section 5.

## Restauration sur B

| Heure (UTC) | Étape | |
|---|---|---|
| 14:09:12 | début, `provision --env production` | |
| 14:10:20 | provisionné, code 0 | base et trois buckets en `eu`, migrations appliquées, sur Miijot que le manifeste nomme |
| 14:11:12 | restauré, code 0 | l'avertissement « l'archive vient du compte A » ; 44 instructions ; 8 objets reversés dans `minshop-pilote-certif-production-images` (correctif 2) ; 26 tables identiques, empreinte pour empreinte ; la section Coffre (correctif 3) |
| 14:17:40 | `deploy` en 5 | `npm run verify` rouge, rien de téléversé (« Défauts » 1) |
| 14:20:07 | relance, la clé en fichier | |
| 14:33:05 | `deploy` en 5 | verify vert, archive préalable dans `-backups` de B, build, Worker téléversé et servi ; le cron refusé, code 10063 (« Défauts » 2) |
| 14:36:52 | relance, le sous-domaine workers.dev de B créé | `--skip-verify --skip-build` |
| 14:38:33 | `deploy` en 0 | `AUTH_SECRET` et `SECRETS_KEK` générés, cinq contrôles verts sur `certif-minshop.miijot.fr` |

**RTO : 29 min 21 s**, sous les 60 minutes. Sans incident, la chaîne tient
en un quart d'heure : `provision` 68 s, `restore` 52 s, `deploy` complet
13 min, dont 6 de `verify`.

Le coffre (`coffre-b.txt`) : connexion refusée avant le remède (200, « La
vérification a échoué »), acceptée après (303 vers `/admin`), avec la
commande exacte que `restore` a donnée. Servie (`servie-b.txt`) : vitrine et
catalogue en 200, 20 produits dans l'API, une image en `200 image/png` lue
dans le bucket de B.

## Destruction de B

`destroy-b-simulation.json` liste les six ressources. Le premier passage sort
en 6 : Worker, namespace des sessions et bucket de fichiers partis ; R2 refuse
les buckets d'images et de sauvegardes avec sa propre phrase, « The bucket you
tried to delete … is not empty », et le code **10008** (la fiche annonce
10014) ; la base gardée. Huit images et les deux archives de `deploy` vidées
(`143152Z`, `143720Z`), le second passage sort en 0 : les deux buckets puis la
base. Plus rien sur B : ni bucket, ni base, ni namespace.

Le domaine répondait encore 530 (erreur 1016) juste après, puis ne résolvait
plus à 15:10. L'export de la zone `miijot.fr` (14:59) ne porte aucun
enregistrement pour `certif-minshop.miijot.fr` lui-même : seuls restent les
enregistrements d'envoi de Resend (`send.`, `rsend.`,
`resend._domainkey.certif-minshop`), posés à l'étape 1 et à garder pour
l'étape 9.

## Staging : secret, mot de passe, acheteur, média

**`AUTH_SECRET`** : connexion en 303, admin en 200 ; après la rotation et 30
secondes, l'admin en 303 vers `/admin/login`, vitrine, catalogue et panier en
200 ; reconnexion en 303, admin en 200.

**Mot de passe perdu**, selon le runbook : `provision --env staging` pour
rendre `wrangler.jsonc`, `scripts/admin-reset.sh --remote` (une ligne
supprimée) à 14:44:26, l'assistant rechargé aussitôt, nom et fuseau gardés, un
mot de passe neuf. À 14:45:29 l'assistant refermé (303), l'ancienne session
tombée, la nouvelle connexion en 303 puis 200. `MINSHOP_ADMIN_PASSWORD`
remplacé dans l'environnement staging. Deux écarts au runbook : la
confirmation de `admin-reset.sh` lui a été passée par un tube (`printf 'y\n'`),
la commande étant lancée sans clavier ; et `wrangler.jsonc` est resté rendu
pour le staging dans l'arbre, ce que le runbook ne dit pas de défaire (remis
par `git restore` avant ce commit).

**Acheteur de test** : la commande `ord_y68x861wxw` (un porte-clés, 20,90 €
dont 3,48 € de TVA), carte `4242`, une adresse marquée pour l'étape qui ne
figure dans aucune preuve. L'export en 0 : 6 lignes dans `orders`,
`order_items`, `order_item_ids`, `order_guest_access` et
`order_notifications`, 3 colonnes retenues et nommées, les deux identifiants
Stripe signalés comme une demande à faire chez Stripe ; le document en clair
supprimé ensuite. L'anonymisation en 0, « plus rien sous cette adresse » ; le
second export avec `found: false`. `privacy-commande-apres.json` : la commande
garde son numéro, ses montants et sa TVA, sous un pseudonyme tiré au hasard,
le pays seul pour adresse. Son lien de suivi répond la même page qu'un jeton
inventé, sans article ni montant (`privacy-lien-suivi.txt`).

**Média** : la « Croix de test média » créée avec une image ; après la
suppression de l'objet dans R2, la fiche, le catalogue et l'API en 200,
l'image demandée avec `?apres` en `404 text/plain`, sans paramètre encore en
200 depuis le cache de Cloudflare. Observability : aucune exception sur ces
requêtes ; une trace `r2_delete` en erreur à 14:52:32 (« The specified key
does not exist », 10007), qui est la suppression depuis Médias d'un objet déjà
parti, et qui a abouti (`media-nettoye.json`, `n = 0`). Nettoyé avant le
nocturne.

## Défauts et écarts

1. **Socle : une clé de sauvegarde exportée fait échouer `deploy`.**
   `test/helpers/provisioned-shop.mjs` lance `shopctl` avec l'environnement de
   l'opérateur et n'y vide que `CLOUDFLARE_ACCOUNT_ID` et
   `CLOUDFLARE_API_TOKEN`. Avec `SHOPCTL_BACKUP_KEY` posée, comme la fiche le
   fait dans le second arbre et comme le runbook « base corrompue » le permet,
   huit tests de `repo`, `deploy`, `restore` et `backup verify` voient la
   vraie clé et rougissent (`deploy-b-1-verify-rouge.json`) : la restauration
   vers un autre compte ne passe pas telle qu'écrite. Contourné en posant la
   même clé en fichier dans `.shopctl/`. À corriger dans le socle, avec un
   test qui exporte la variable.
2. **Un compte neuf n'a pas de sous-domaine workers.dev**, et Cloudflare
   refuse alors le cron (10063) après avoir téléversé le Worker. De 14:33 à
   14:38, la boutique a été servie sur son domaine sans `AUTH_SECRET` ni
   `SECRETS_KEK`, que `deploy` pose après le téléversement. Ouvrir une fois
   Workers & Pages sur B l'a créé. Le guide des comptes (§4) ne le demande
   pas, `provision` ne le vérifie pas, et la première production de l'étape 9
   l'aurait rencontré.
3. **`shopctl` ne relaie que la première ligne de l'erreur de wrangler.**
   `deploy-b-2-cron-refuse.json` dit « only partially updated: » et
   s'arrête ; la cause et son remède n'étaient que dans le journal de
   wrangler (`deploy-b-2-wrangler.txt`).
4. **Le jeton du monitor demande plus que ce que son aide annonce.** Avec
   « Account Analytics : Read » seul, `monitor` sort en 4, « wrangler n'est
   pas authentifié » : il passe le même jeton à `wrangler whoami` et
   `d1 list`. Il a fallu ajouter D1 Read, Account Settings Read, et côté
   utilisateur Memberships Read et User Details Read (`/memberships` et
   `/user` en 403 sans eux). Cela confirme le doute de l'étape 6 sur le jeton
   de lecture de la production (`MONITOR_CLOUDFLARE_API_TOKEN`), documenté
   sans ces droits : à régler avant l'étape 9.
5. **La fiche annonce le code R2 10014** ; R2 répond 10008.
6. **Le staging envoie depuis `onboarding@resend.dev`**, le domaine de test
   de Resend, et non depuis `commandes@certif-minshop.miijot.fr` que le
   manifeste déclare. Resend refuse alors tout destinataire autre que le
   titulaire du compte : le reçu de `ord_y68x861wxw` a été refusé (403,
   « Testing domain restriction »), la notification au marchand est partie.
   Les reçus des étapes 4 et 6 ne prouvent donc l'envoi que vers l'adresse du
   titulaire. Réglage du staging, pas du socle ; l'étape 9 pose l'adresse du
   domaine vérifié.
7. **L'anonymisation ne clôt pas les notifications client en attente.** Le
   reçu refusé est resté `pending` ; le cron l'a retenté après l'effacement,
   vers le pseudonyme en `exemple.invalid`, jusqu'à sa cinquième tentative.

## Ce qui reste

- Le jeton de service Access « pilote-certif étape 8 » est révoqué à la fin
  de l'étape, et le jeton Analytics, élargi pour la section 9, supprimé.
- Défauts 1 à 5 et 7 : à corriger dans le socle, dans une version suivante.
- L'adresse d'expédition de la production (défaut 6) : à l'étape 9.
