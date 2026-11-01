# Compte mutualisé — migration de pilote-certif (lot 8)

Fiche de passage pour le poste de Damien. Elle déplace la production de
pilote-certif de son compte client (B) vers le compte Cloudflare mutualisé
([ADR 0019](../architecture/decisions/0019-compte-cloudflare-mutualise.md),
plan §13.1, lot 8) : c'est la [sortie client, §1 bis](../operations/sortie-client.md#1-bis-quitter-le-compte-mutualisé)
jouée à l'envers. Travail d'après le pilote, hors des jalons 0 à 10.

Ni base, ni bucket, ni Worker ne changent de compte : la boutique est
sauvegardée sur B, recréée et restaurée sur le compte mutualisé, déployée
avant la bascule, puis son domaine bascule par un CNAME vers l'origine de repli
de la zone SaaS (dg-tech.dev). B n'est détruit qu'après une nuit verte de la
flotte. Le domaine de la boutique et sa zone miijot.fr restent sur B : seul
`certif-minshop.miijot.fr` change de destination.

Compter une heure et demie, dont **jusqu'à trente minutes de coupure** :
quatre entre le retrait du domaine du Worker de B et le certificat du nom
d'hôte personnalisé, mais un résolveur qui demande le domaine pendant le trou
garde la réponse vide jusqu'au minimum du SOA de miijot.fr, 1 800 s (§3). Les
commandes sont fermées pendant toute la migration.

Elle a été répétée en doublure le 2026-10-28 (section 9) ; les défauts trouvés
sont corrigés dans le socle `v0.3.33`. Elle a été jouée pour de vrai les 29 et
30 octobre 2026 (section 10) ; ce qu'elle a trouvé est corrigé en `v0.3.34`.

## 0. Avant le jour J

- [ ] **la clé de sécurité matérielle** sur l'utilisateur du compte mutualisé
  (l'écart du [§4 de l'essai](compte-mutualise-essai-saas.md#4-résultat-du-2026-10-28)) ;
- [ ] **pilote-certif au socle v0.3.33**, sur B, comme toute montée :
  `npm run shopctl -- core upgrade --to v0.3.33`, la pull request fusionnée,
  `npm run shopctl -- provision --env production` (le marqueur de la base et
  les deux règles de conservation de v0.3.32), puis le Deploy de la boutique,
  approuvé. La sauvegarde de B et la restauration sur le compte mutualisé se
  font ainsi avec le même socle ;
- [ ] **deux jetons de plus sur le compte mutualisé**, à côté du jeton de
  déploiement de l'essai ([§1.4](compte-mutualise-essai-saas.md#1-dans-le-tableau-de-bord-une-fois-pour-toutes)),
  *Account Resources* : le compte mutualisé seul :
  - sauvegarde nocturne : D1 en lecture, Workers R2 Storage en écriture,
    Account Settings en lecture ; côté utilisateur, Memberships et User
    Details en lecture ;
  - lecture pour `monitor` : Account Analytics, D1 et Account Settings en
    lecture ; côté utilisateur, Memberships et User Details en lecture ;
- [ ] **un widget Turnstile** sur le compte mutualisé (Turnstile → Add widget,
  nom d'hôte `certif-minshop.miijot.fr`, le premier d'un lot de dix) : sa clé
  de site et sa clé secrète dans le gestionnaire de mots de passe ;
- [ ] le jeton de déploiement de B encore valide : il sert à la sauvegarde du
  jour J et à la destruction finale.

Toutes les commandes se lancent sous Node 22 (≥ 22.23.4). Les jetons
s'exportent sans écho, jamais en argument (`read -rs`). Un clone qui porte le
remote `core` fait refuser à `gh` de choisir son dépôt :
`gh repo set-default DamienGR/shop-pilote-certif` une fois avant.

## 1. Sur B : fermer, sauvegarder (dix minutes, plus trente d'attente)

- [ ] Admin → Réglages → Paiements : chaque moyen désactivé. Le panier seul ne
  suffit pas : l'achat immédiat et l'API de commande passent sans lui. Puis
  **attendre trente minutes**, la durée d'une session de paiement Stripe
  ouverte avant la fermeture.

```sh
cd <clone de shop-pilote-certif>
git switch main && git pull && npm ci
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # jeton de déploiement de B
npm run shopctl -- backup --env production --upload
npm run shopctl -- backup pull <id> --env production
npm run shopctl -- backup verify <id>
git worktree add ../pilote-certif-B HEAD && (cd ../pilote-certif-B && npm ci)
```

Noter l'`<id>` (`pilote-certif-production-<horodatage>`). `pull` rapatrie
aussi les images que l'archive a laissées dans le pool du bucket `-backups`.
L'arbre `../pilote-certif-B` garde le manifeste de B pour la destruction (§7)
ou le retour arrière (§3) ; il lui faut ses propres `node_modules`, shopctl y
appelant le wrangler de l'arbre.

## 2. Sur le compte mutualisé : recréer, restaurer, déployer (vingt minutes)

La boutique sert toujours depuis B pendant toute cette section.

```sh
git switch -c migration/compte-mutualise
```

Dans `client/client.yaml`, sous `cloudflare:`, de `imagesDomain` jusqu'à la
fin du bloc :

```yaml
  imagesDomain: images-certif-minshop.dg-tech.dev
  # Compte Cloudflare mutualisé de l'agence (ADR 0019). `shopctl provision`
  # refuse tout autre compte : provisionner ailleurs ne se défait pas.
  accountId: <id du compte mutualisé>
  # Zone Cloudflare for SaaS du compte mutualisé : le domaine de production y
  # est un nom d'hôte personnalisé, par un CNAME vers son origine de repli.
  saasZone: dg-tech.dev
```

`productionAccountId` et les trois lignes de staging (`stagingDomain`,
`stagingAccessTeam`, `stagingAccessAud`) disparaissent : la preview du compte A
a été détruite à l'étape 9. Le domaine d'images change parce que le domaine
personnalisé d'un bucket R2 est toujours dans une zone du compte du bucket.

```sh
npm run shopctl -- config validate
git commit -m "Passer pilote-certif sur le compte mutualisé (ADR 0019)" -- client/client.yaml
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # jeton de déploiement du compte mutualisé
npm run shopctl -- provision --env production --dry-run
npm run shopctl -- provision --env production
```

Le manifeste seul dans le commit : `wrangler.jsonc` porte le rendu de
production de B, écrit par la sauvegarde du §1, et n'a rien à faire dans la
pull request. Sous `v0.3.33`, le remettre d'abord
(`git checkout -- wrangler.jsonc`) : `provision` y prenait l'identifiant de la
base de B pour poser le marqueur, et échouait sur le code 7404 en laissant une
base neuve sans marqueur (§10 ; un second passage la marque). `v0.3.34`
s'adresse à la base par son identifiant.

Attendu : le compte mutualisé nommé par `cloudflare.accountId`, la base et les
trois buckets créés en juridiction eu, la base marquée pour pilote-certif
(`DamienGR/shop-pilote-certif`), les deux règles de conservation,
`certif-minshop.miijot.fr — créé, en attente du DNS du commerçant`, et le
rappel d'attacher le domaine d'images.

- [ ] tableau de bord du compte mutualisé → R2 →
  `minshop-pilote-certif-production-images` → Settings → Custom Domains →
  `images-certif-minshop.dg-tech.dev`, jusqu'à « Active » (la zone est sur le
  compte : Cloudflare pose l'enregistrement).

```sh
npm run shopctl -- restore --env production --from <id> --allow-production --confirm pilote-certif
```

Attendu : « l'archive vient du compte Miijot (b8505b…) », le compte B
(restauration inter-comptes, voulue ici), « cible vierge », les tables identiques à l'archive empreinte pour
empreinte, un objet reversé par image, puis, sous **Coffre**, les clés qui ne
s'ouvrent plus : elles étaient scellées par la `SECRETS_KEK` du Worker de B.
Si la restauration dit que Turnstile est activé avec une clé illisible, lancer
la commande `npx wrangler d1 execute … DELETE FROM settings WHERE key =
'turnstile_enabled'` qu'elle affiche, avec `CLOUDFLARE_ACCOUNT_ID` : sans elle,
la connexion à l'administration serait refusée.

```sh
npm run shopctl -- deploy --env production --yes --skip-smoke
```

Attendu : le nom d'hôte « pas encore actif », dit en avertissement
(`--skip-smoke` : le test de fumée viendra au §5), la sauvegarde préalable,
le build, `AUTH_SECRET` et `SECRETS_KEK` générés et transmis par entrée
standard, et pour finir « pilote-certif est déployé en production, mais
https://certif-minshop.miijot.fr ne mène à lui qu'une fois son nom d'hôte
actif ».

## 3. La bascule (quatre minutes de coupure, jusqu'à trente)

Sur B, dans le tableau de bord, les deux gestes enchaînés sans pause. Entre
eux, le domaine n'existe plus : un résolveur qui le demande à ce moment garde
la réponse vide trente minutes, le minimum du SOA de miijot.fr. Le
2026-10-29, une minute et demie d'intervalle a coûté vingt-six minutes de
coupure au poste de Damien, quatre aux résolveurs qui n'avaient rien demandé
pendant le trou.

- [ ] Workers & Pages → `minshop-pilote-certif-production` → Settings →
  Domains & Routes → `certif-minshop.miijot.fr` → Remove. **La boutique ne
  répond plus.**
- [ ] DNS de miijot.fr → Add record : `CNAME`, nom `certif-minshop`, cible
  `fallback.dg-tech.dev`, **DNS only** (nuage gris). Si Cloudflare refuse, un
  autre enregistrement porte encore ce nom : le domaine du Worker n'est pas
  parti.

Puis, depuis l'arbre, toutes les deux minutes :

```sh
npm run shopctl -- provision --env production
```

jusqu'à `certif-minshop.miijot.fr — actif`. La vitrine répond alors, et
l'administration accepte le mot de passe d'avant (Turnstile coupé).

**Retour arrière**, tant que le §7 n'est pas joué : supprimer le CNAME, puis
depuis `../pilote-certif-B`, avec le jeton de déploiement de B,
`npm run shopctl -- deploy --env production --yes --key-file ../shop-pilote-certif/.shopctl/backup.key`,
qui rattache le domaine au Worker de B. La clé en argument : un déploiement de
production commence par une sauvegarde, et `.shopctl/`, ignoré par git, n'est
pas dans l'arbre mis de côté. Rien n'est perdu : les commandes sont fermées
depuis la sauvegarde.

## 4. Le dépôt de flotte (quinze minutes)

À côté du clone du pilote :

```sh
mkdir ../minshop-fleet && cd ../minshop-fleet
cat > fleet.json <<'EOF'
{
  "schemaVersion": 1,
  "core": { "repository": "DamienGR/minshop-platform" },
  "shops": [
    { "slug": "pilote-certif", "path": "../shop-pilote-certif", "repository": "DamienGR/shop-pilote-certif" }
  ]
}
EOF
git init -b main
node ../shop-pilote-certif/shopctl/bin/shopctl.mjs fleet init
git add -A && git commit -m "Flotte : registre et workflows"
```

(`path` est le dossier du clone, relatif à `fleet.json`.) Puis les jetons du
compte mutualisé et la clé des archives, celle du pilote : l'archive du jour J
et toutes les suivantes s'ouvrent avec la même.

```sh
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN                 # déploiement
read -rs CLOUDFLARE_API_TOKEN_BACKUP && export CLOUDFLARE_API_TOKEN_BACKUP   # sauvegarde nocturne
read -rs CLOUDFLARE_API_TOKEN_MONITOR && export CLOUDFLARE_API_TOKEN_MONITOR # lecture
export SHOPCTL_BACKUP_KEY="$(cat ../shop-pilote-certif/.shopctl/backup.key)"
node ../shop-pilote-certif/shopctl/bin/shopctl.mjs fleet repo --reviewer DamienGR
gh variable set MINSHOP_ACCOUNT_PLAN --body free -R DamienGR/minshop-fleet
```

Attendu : `DamienGR/minshop-fleet` créé public, `main` poussée, les
environnements `staging`, `production` (un relecteur) et `backup` (limité à
`main`), chacun avec son jeton, le compte et la clé (`a08808754f049baf`,
l'identifiant de la clé du pilote), et les deux secrets de surveillance du
dépôt. Le compte est
lu dans le manifeste du pilote : le clone doit être sur la branche
`migration/compte-mutualise`. La variable dit à la nuit de juger le compte au
plan gratuit.

## 5. Le dépôt de la boutique

Depuis le clone du pilote, toujours sur la branche :

```sh
npm run shopctl -- repo --fleet DamienGR/minshop-fleet
```

Attendu : la branche poussée, la variable `MINSHOP_FLEET` posée (le Deploy et
le Nightly de la boutique laissent le compte à la flotte), et une ligne
`gh secret delete …` par jeton de B encore posé dans le dépôt : six, deux du
dépôt et deux par environnement. Les garder jusqu'au §7 : le retour arrière en
a besoin. Une dernière ligne dit qu'aucun `fleet.json` n'est au-dessus du
clone ; sans objet ici, le registre est à côté et nomme déjà la boutique.

- [ ] la pull request `migration/compte-mutualise`, fusionnée ;
- [ ] `gh workflow run deploy.yml -R DamienGR/minshop-fleet -f shop=pilote-certif -f environment=production`,
  approuvé : `npm run verify`, `provision`, `deploy`, test de fumée verts.

## 6. Remettre la boutique en état

- [ ] Admin → Réglages, ressaisis : chaque clé que la restauration a nommée
  sous **Coffre** (Resend ; Stripe s'il y était), et sous Protection
  anti-robots les deux clés du widget du compte mutualisé, Turnstile réactivé ;
- [ ] un e-mail de test depuis Admin → Réglages → E-mail ; une déconnexion et
  une reconnexion, widget affiché ; une fiche produit dont l'image vient de
  `images-certif-minshop.dg-tech.dev` ;
- [ ] les moyens de paiement réactivés, s'ils l'étaient avant le §1 ;
- [ ] `gh workflow run nightly.yml -R DamienGR/minshop-fleet` : sauvegarde,
  `backup verify`, `monitor` et `fleet usage` au plan gratuit, verts.

## 7. Fermer B, après une nuit verte de la flotte

La nuit, c'est le run programmé du créneau de 03:17 UTC, le seul qui joue la
sauvegarde, `monitor` et `fleet usage` ensemble ; celui de 15:17 ne fait que la
sauvegarde. GitHub lance ces crons avec cinq à sept heures de retard (10:02
pour le premier de la flotte, le 2026-10-30) : il arrive en fin de matinée.

Depuis `../pilote-certif-B`, avec le jeton de déploiement de B. Tableau de
bord de B → R2, en vérifiant d'abord que le compte affiché est bien B : les
buckets du compte mutualisé portent exactement les mêmes noms, et vider le
mauvais effacerait les images de la boutique en ligne. Le domaine attaché au
bucket d'images le dit : `…miijot.fr` sur B, `…dg-tech.dev` sur le compte
mutualisé.

- [ ] `minshop-pilote-certif-production-images` → Settings → Custom Domains →
  `images-certif-minshop.miijot.fr` → Remove ;
- [ ] Settings → Empty Bucket, sur chaque bucket de la boutique qui porte des
  objets : images et sauvegardes au moins. R2 refuse de supprimer un bucket
  non vide, et `destroy` le dit.

```sh
cd ../pilote-certif-B
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # jeton de déploiement de B
npm run shopctl -- destroy --env production --confirm pilote-certif --dry-run
npm run shopctl -- destroy --env production --confirm pilote-certif --yes
cd ../shop-pilote-certif && git worktree remove ../pilote-certif-B
```

Attendu : le compte B nommé par le manifeste de l'arbre, puis le Worker, le
namespace des sessions, les trois buckets et la base supprimés, dans cet
ordre. Ensuite :

- [ ] les lignes `gh secret delete …` du §5 jouées ; ou, plus court, les deux
  secrets de surveillance du dépôt supprimés et les deux environnements de la
  boutique avec eux (`production` et `backup` ; plus de `staging` depuis la
  destruction de la preview, étape 9), qui emportent aussi leurs copies de la
  clé de sauvegarde. Le
  Deploy et le Nightly de la boutique ne les ouvrent plus depuis que
  `MINSHOP_FLEET` est posée :
  ```sh
  R=DamienGR/shop-pilote-certif
  gh secret delete MONITOR_CLOUDFLARE_ACCOUNT_ID -R $R && gh secret delete MONITOR_CLOUDFLARE_API_TOKEN -R $R
  gh api -X DELETE repos/$R/environments/production && gh api -X DELETE repos/$R/environments/backup
  ```
- [ ] les jetons de la boutique révoqués sur B (déploiement, sauvegarde,
  lecture). La page *API Tokens* du profil liste aussi ceux du compte
  mutualisé, que la flotte utilise : ne révoquer que ceux dont *Account
  Resources* nomme B, puis lancer un Nightly de la flotte à la main, qui prouve
  que la sauvegarde et la lecture tiennent. B garde la zone miijot.fr : son DNS
  porte le CNAME de la boutique et les enregistrements Resend ;
- [ ] l'archive du jour J (`backups/<id>`, chiffrée) gardée sur le poste
  quatre-vingt-dix jours, le temps que la flotte en ait autant, puis effacée.

## 8. Clore

Les sorties de chaque commande vont, comme aux étapes de la certification,
dans une pull request de preuves de `shop-pilote-certif`
(`client/certification/compte-mutualise/`). Le résultat entre dans
l'ADR 0019 (Vérification) et le plan §13.1 par une pull request du socle.

## 9. Répétition en doublure du 2026-10-28

Jouée dans un conteneur, sur un clone du pilote monté en v0.3.32, avec le
wrangler de doublure (un état pour B, un pour le compte mutualisé), la doublure
de l'API Cloudflare (zone dg-tech.dev, origine de repli active), celle de
l'API GraphQL et un `gh` de doublure. Tout est passé :

- sur B : `provision`, `deploy`, puis `backup --upload`, `backup pull` et
  `backup verify` (code 0) ;
- sur le compte mutualisé : `provision` (nom d'hôte créé en attente),
  `restore` inter-comptes (26 tables identiques, une image reversée, trois
  clés du coffre et Turnstile signalés), la commande de Turnstile, `deploy
  --skip-smoke` avant la bascule ; puis, le nom d'hôte actif, `provision` et
  `deploy` comme les enchaîne le Deploy de la flotte, secrets conservés ;
- la flotte : `fleet init`, `fleet repo` (aucun jeton dans un argument), `repo
  --fleet` qui nomme les six secrets de B restés dans le dépôt ; la nuit
  rejouée commande par commande : `backup --upload` qui réutilise l'image du
  pool, `backup verify`, `monitor --plan free` et `fleet usage --plan free`
  verts ;
- la destruction de B depuis l'arbre mis de côté : refusée tant que deux
  buckets portent des objets (la base intacte), complète une fois vidés.

Ce qu'elle a trouvé, corrigé dans `v0.3.33` (`docs/migrations/v0.3.33.md`) :

1. **la clé de sauvegarde n'était pas ignorée dans le dépôt de flotte.**
   `fleet repo` lit `.shopctl/backup.key` à la racine de la flotte, mais
   `fleet init` n'ignorait que les dossiers des boutiques : un `git add -A`
   l'aurait publiée dans un dépôt public. `fleet init` ignore désormais
   `/.shopctl/`, et `fleet repo` refuse (code 4) une clé présente dans l'index,
   avant de créer ou de pousser quoi que ce soit ;
2. **`deploy` disait la boutique « en ligne » avant la bascule**, sur un
   domaine qui menait encore à B. Avec un nom d'hôte en attente, il dit
   maintenant qu'elle est déployée et que le domaine ne mène à elle qu'une fois
   le nom d'hôte actif ;
3. **la consigne du CNAME** visait « le registrar du commerçant » : sa zone
   peut être chez Cloudflare, comme miijot.fr, et le CNAME y est alors en DNS
   seul ;
4. **la sortie client, §1 bis**, dont cette fiche est l'envers : `destroy` de
   la production demande `--yes`, l'arbre mis de côté a besoin de `npm ci`, le
   domaine d'images doit changer de zone avec le compte et se retirer du bucket
   avant sa suppression, et fermer les commandes, c'est couper les moyens de
   paiement puis attendre trente minutes, pas seulement désactiver le panier ;
5. **le droit du jeton de déploiement sur la zone SaaS** (Zone en lecture, SSL
   and Certificates en écriture) manquait au tableau des
   [comptes et accès, §4](comptes-et-acces.md).

Hors de portée de la doublure : le vrai DNS et l'émission du certificat (vus
à l'essai du lot 3), le test de fumée, les workflows de GitHub, la saisie
dans l'administration.

## 10. Résultat des 29 et 30 octobre 2026

**Migration faite.** pilote-certif sert depuis le compte mutualisé
(`305a2bac…`) depuis le 2026-10-29 à 21 h 24 UTC, et B est détruit depuis le
2026-10-30 à 10 h 50, après le premier Nightly programmé de la flotte, vert.
Les sorties de chaque commande sont dans la pull request de preuves de
`shop-pilote-certif` (`client/certification/compte-mutualise/`). Heures UTC.

| § | Quand | Ce qui s'est passé |
|---|---|---|
| 0 | 29/10 | pilote monté en `v0.3.33` (pull request #43) ; `provision` sur B : la base marquée (« base antérieure au marqueur »), la règle des archives remplacée, celle du pool posée ; Deploy de la boutique vert |
| 1 | 17:29 | moyens de paiement déjà tous inactifs (clés Stripe retirées à l'étape 10), pas d'attente ; archive `pilote-certif-production-20261029T172928Z`, 106 lignes et 8 images, `pull` et `verify` verts |
| 2 | 17:45–19:41 | premier `provision` en échec (défaut 1 ci-dessous), le second vert ; domaine d'images attaché ; `restore` : 26 tables identiques, 8 objets reversés, Resend et Turnstile illisibles, Turnstile coupé par la commande affichée ; `deploy --skip-smoke` : `AUTH_SECRET` et `SECRETS_KEK` générés |
| 3 | 21:20–21:46 | domaine retiré du Worker de B à 21:20:58, CNAME vu par 1.1.1.1 à 21:22:29, certificat du nom d'hôte vers 21:24:20 ; le poste ne voit le CNAME qu'à 21:46:44 (cache négatif) |
| 4 | 21:36 | `DamienGR/minshop-fleet` créé public, trois environnements, clé `a08808754f049baf`, plan gratuit |
| 5 | 21:37–22:23 | `repo --fleet` : six secrets de B nommés ; pull request #44 fusionnée ; Deploy de la flotte vert (run 40964138461) |
| 6 | 22:00–22:33 | Resend ressaisi, e-mail de test reçu ; Turnstile du compte mutualisé, reconnexion avec le widget ; images servies par `images-certif-minshop.dg-tech.dev` ; Nightly manuel vert (run 40966588970) |
| 7 | 30/10, 10:02–11:15 | Nightly programmé vert (run 41037762590 : 0 erreur sur 1 144 requêtes, un Worker sur le compte) ; `destroy` de B, simulation puis six ressources supprimées ; dépôt de la boutique sans secret ni environnement ; jetons de B révoqués ; Nightly manuel vert après la révocation (run 41056994612) |

La coupure : **vingt-six minutes vues du poste de Damien** (21:20:58 →
21:46:44), dont vingt-deux de cache négatif ; quatre pour un résolveur qui
n'avait pas demandé le nom pendant le trou. La fiche en annonçait cinq.

Trois écarts à la fiche, acceptés par Damien :

- **la clé de sécurité matérielle**, commandée, n'était pas arrivée : la
  migration s'est faite sous la double authentification par application,
  l'écart du lot 3 maintenu. La clé se pose à réception ;
- **aucune attente au §1** : aucun moyen de paiement n'était actif, donc
  aucune session de paiement ne pouvait être ouverte ;
- **les noms des jetons révoqués sur B** n'ont pas été relevés. Trois jetons
  du compte mutualisé restaient ensuite, et le Nightly manuel l'a confirmé.

Ce qu'elle a trouvé, corrigé en `v0.3.34` (`docs/migrations/v0.3.34.md`) :

1. **`provision` sur le compte mutualisé visait la base de B.** La sauvegarde
   du §1 avait rendu `wrangler.jsonc` pour la production de B. Wrangler résout
   un nom de base par ce fichier d'abord et prend l'identifiant qu'il y trouve :
   le marqueur est parti vers l'identifiant de la base de B, inconnu du compte
   mutualisé (code 7404), en laissant la base neuve sans marqueur. La ligne
   « marquée pour » s'était affichée avant l'écriture. Le marqueur, le contrôle
   de juridiction et la suppression de la base s'adressent désormais à la base
   par son identifiant, et la ligne suit l'écriture. La doublure ne l'avait pas
   vu : son wrangler résolvait le nom par le compte, sans lire l'identifiant de
   la configuration. Il le lit maintenant, comme le vrai ;
2. **`git commit -am` au §2** emportait `wrangler.jsonc` avec le manifeste : le
   commit ne nomme plus que `client/client.yaml` ;
3. **le retour arrière du §3**, non joué, aurait échoué faute de clé de
   sauvegarde dans l'arbre mis de côté : `--key-file` ;
4. **la clé du pilote** est `a08808754f049baf`, pas `64fb…` ;
5. **la coupure** : jusqu'à trente minutes, pas cinq (§3, et la sortie client,
   §1 bis, pour le sens inverse) ;
6. **`repo --fleet`** disait les six secrets de B « jeton du compte
   mutualisé » ; il dit qu'ils peuvent venir de l'ancien compte, que le retour
   arrière garde ;
7. **`deploy`** écrivait « déployé — https://certif-minshop.miijot.fr » avec un
   nom d'hôte en attente : la ligne le dit maintenant ;
8. **le §7** : le run programmé arrive en fin de matinée ; les buckets de B et
   du compte mutualisé ont les mêmes noms ; supprimer les environnements laisse
   les deux secrets de surveillance du dépôt ; la page des jetons liste ceux des
   deux comptes.
