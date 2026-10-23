# Étape 9 — Bascule sur le compte « client » : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 9 du
[plan](plan.md#étape-9--bascule-sur-le-compte--client-) : le pilote monte en
`v0.3.18` ; les trois achats manuels qui restaient de l'étape 6 se font sur le
staging pendant qu'il existe ; la production de `pilote-certif` est créée sur
le compte B, son mot de passe posé avant tout déploiement, déployée par le
workflow `Deploy`, installée et saisie sur B, contrôlée par la porte distante
et par une nuit de sauvegarde ; puis le staging de A est détruit. Elle est
aussi la première exécution de la
[checklist de lancement](../operations/mise-en-ligne.md), que chaque boutique
rejouera.

Elle a été répétée le 2026-10-20 dans un conteneur : le pilote en `v0.3.13`
sur un `wrangler` de doublure qui voit A et B et un `gh` de doublure ; le
staging sur A, `shopctl repo` avec le seul jeton de production, `provision`
sur B, le chemin du workflow `Deploy` rejoué hors de GitHub (`provision` puis
`deploy --skip-verify` avec les secrets de l'environnement), la production
construite servie en local, installée, son catalogue importé, la porte
distante, puis `destroy` du staging. Six défauts, corrigés dans `v0.3.14`, et
la répétition rejouée sur le socle corrigé.

## Ce que la répétition a trouvé

Corrigé dans `v0.3.14` (`docs/migrations/v0.3.14.md`) :

1. **Le premier déploiement ouvrait l'assistant au public.** La base de B est
   neuve : pas de mot de passe, donc `/admin/setup` répond à quiconque, sur un
   domaine dont le certificat vient d'être publié. Le test de fumée le
   signalait (« l'assistant d'installation est ouvert ») sans rien pouvoir y
   faire. `shopctl admin password` pose le haché avant le premier
   déploiement (section 5) ; l'assistant ne s'ouvre ensuite qu'après
   connexion.
2. **La production prenait des commandes sans paiement.** Sans Stripe, le
   paiement de démonstration est offert : n'importe qui commande, réserve du
   stock et reçoit un e-mail de confirmation, jusqu'à l'étape 10. `provision`
   le coupe dans une production jamais installée ; le panier dit alors « La
   commande est momentanément indisponible. ».
3. **Le domaine d'images était rendu partout.** Déclaré dans le manifeste, il
   passait dans le `wrangler.jsonc` du staging et des builds locaux. Seule la
   production le rend désormais, et `deploy --env production` refuse un
   domaine qui n'est pas attaché au bucket d'images.
4. **La porte distante échouait sur la production sans Stripe** : `/express`
   y renvoie vers la fiche (303). Elle l'accepte, et le dit.
5. **Le nocturne aurait été rouge chaque nuit après la destruction du
   staging, et la production n'y était pas sauvegardée.** La variable
   `STAGING_RETIRED` éteint la partie staging ; un job sauvegarde la
   production chaque nuit dans l'environnement GitHub `backup`, avec son
   propre jeton de B.
6. **`destroy` renvoyait vers `r2 object delete <clé>`** pour les archives du
   nocturne, dont personne ne connaît les clés ; il nomme le vidage du
   tableau de bord.

Non répétés, faute de doublure : le domaine de production et son certificat
sur B, le domaine d'images, l'approbation GitHub, le vrai Resend, le vrai
Turnstile, Access.

## Ce que le passage réel a trouvé

Le passage des 2026-10-21 et 2026-10-22 a fait publier quatre versions du
socle, chacune avant la section qu'elle protégeait :

1. **`v0.3.15`** : l'alerte `markdown-it` du `Nightly`, sans laquelle le job
   `Dependency audit` est rouge aux sections 9 et 10 ;
2. **`v0.3.16`** : le navigateur versait le mot de passe de l'administration
   dans les champs de clé de Réglages, et l'enregistrement remplaçait la clé
   (Resend a refusé l'e-mail de test du staging) ;
3. **`v0.3.17`** : trois défauts de la vitrine, vus pendant les achats de la
   section 2. Sur un téléphone, le menu d'`atelier` s'ouvrait hors de l'écran,
   et « Rechercher » et « Panier » en toutes lettres coupaient le nom de la
   boutique ; partout, une quantité tapée dans le panier sans « Mettre à
   jour » était perdue au paiement ;
4. **`v0.3.18`** : la vitrine parlait anglais, vu sur l'accueil de la
   production une fois redéployée en `v0.3.17`. « Shop » et « All products »
   au-dessus du catalogue, « Your cart » en tête du tiroir, « Home » et
   « Shop » dans un menu dont le libellé est laissé vide, et « Breadcrumb »
   pour les lecteurs d'écran de `market`. Aucune porte ne lisait la vitrine :
   le contrôle de langue ne couvrait que l'administration.

Et quatre trous de cette fiche, corrigés ci-dessous : `gh` refusait de choisir
entre les deux remotes du clone (section 0), `catalog import` attendait une
configuration que rien ne rendait plus (section 7), le contrôle du panier
lisait un panier vide (section 8), et la clé Resend du staging n'était pas
révoquée (section 10). Après la destruction, la preview ne résout plus du
tout : son enregistrement DNS est parti avec le domaine du Worker.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare B | **créé et gardé** : Worker `minshop-pilote-certif-production` sur `certif-minshop.miijot.fr`, sa base, ses trois buckets en juridiction `eu`, le domaine d'images `images-certif-minshop.miijot.fr` attaché au bucket d'images, son namespace KV de sessions, ses secrets internes, un cron ; deux jetons API (déploiement, sauvegarde) ; les archives de `deploy` et du nocturne dans `-backups` |
| Cloudflare A | **détruit** : le staging du pilote (Worker, base, trois buckets, namespace KV) ; le jeton de staging révoqué ; les applications Access de la preview et leurs jetons de service supprimés |
| GitHub `shop-pilote-certif` | la pull request `socle/v0.3.18` ; une pull request qui déclare `imagesDomain` ; l'environnement `backup` et ses trois secrets ; le jeton de l'environnement `production` réécrit ; la variable `STAGING_RETIRED` ; l'environnement `staging` supprimé ; une pull request de preuves |
| Stripe test | trois paiements (section 2) ; l'endpoint de webhook de la preview supprimé |
| Resend | le domaine d'envoi vérifié s'il ne l'est pas ; des e-mails réels vers les adresses de Damien |
| Stripe live | rien : l'étape 10 |

**La production est publique dès la section 6**, et le reste : c'est la
boutique. Jusqu'à l'étape 10, elle ne prend aucune commande (aucun moyen de
paiement, la démonstration coupée).

## 0. Shell propre, et ce qui doit exister avant

Prérequis : le tag `v0.3.18`, publié par le workflow `Release` du socle. Il
reprend `v0.3.14` et les quatre versions que le passage réel a fait publier
(ci-dessus).

Sur B, dans le tableau de bord, avant de commencer :

- [ ] Workers & Pages ouvert (fait à l'étape 8) ; R2 activé ;
- [ ] la zone `miijot.fr` sur B (le domaine de production y a été servi à
  l'étape 8) ;
- [ ] **trois jetons API** (droits : [guide des comptes, §4](comptes-et-acces.md)) :
  le jeton de **déploiement** de la production (modèle « Edit Cloudflare
  Workers », plus D1 en écriture et Account Analytics en lecture, ce seul
  compte, la zone `miijot.fr`) ; le jeton de **sauvegarde** (D1 en lecture,
  Workers R2 Storage en écriture, Account Settings en lecture ; côté
  utilisateur Memberships et User Details en lecture ; rien d'autre) ; le
  jeton de **lecture** de l'étape 8, s'il n'existe pas encore ;
- [ ] Turnstile : un widget pour `certif-minshop.miijot.fr`, ses deux clés à
  portée ;
- [ ] Resend : le domaine `certif-minshop.miijot.fr` vérifié (ses
  enregistrements DNS sont dans la zone de B), une clé d'API d'envoi.

```sh
P=<chemin>/shop-pilote-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
cd "$P" && nvm use 22
gh repo set-default DamienGR/shop-pilote-certif     # le clone a deux remotes, core et origin : sans cela, chaque gh de la fiche refuse
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID    # shopctl lit le compte de chaque environnement dans le manifeste
COMPTE_A=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
COMPTE_B=$(awk '/^  productionAccountId:/ {print $2}' client/client.yaml)
export PILOTE="https://$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)"
export PROD="https://$(awk '/^  productionDomain:/ {print $2}' client/client.yaml)"
E="$P/client/certification/etape-9" && mkdir -p "$E"
J=$(mktemp -d)                                       # hors du dépôt : mots de passe et cookies
echo "$COMPTE_A $COMPTE_B $PILOTE $PROD"
npx wrangler whoami                                  # la session voit A et B
```

## 1. Monter le pilote en `v0.3.18`

```sh
npm run shopctl -- core upgrade --to v0.3.18 --open-pr
gh pr checks socle/v0.3.18 --watch
gh pr merge socle/v0.3.18 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.18
npm run -s shopctl -- deploy --env staging --json > "$E/deploy-staging-v0.3.18.json"; echo $?
```

Attendu : la pull request verte, avec les notes de `v0.3.13` à `v0.3.18`
pour un pilote resté en `v0.3.12` ; `deploy` en `0`
sur A. Le staging sert maintenant ses images par le Worker, même une fois
`imagesDomain` déclaré.

Le thème `pilote-certif` est une copie d'`atelier`, et il appartient à la
boutique : la montée ne le touche pas. L'en-tête corrigé d'`atelier` s'y
reporte dans une pull request de la boutique, avec sa signature
(`docs/migrations/v0.3.17.md`, « À faire dans la boutique »), avant le
déploiement du staging. `v0.3.18` ne demande rien au thème.

## 2. Avant que le staging ne parte : les trois achats de l'étape 6

La dernière occasion de payer en mode test sur la boutique : la production
n'aura Stripe qu'à l'étape 10, en live. La procédure est celle de la
[fiche de l'étape 6, section 5](etape-6-commandes.md#5-le-parcours-dachat-à-la-main),
pour les trois navigateurs qui manquent (la commande #6 a déjà couvert le
premier). Dans `client/certification/etape-6/README.md` du pilote, sur la même
branche que les preuves de cette étape : navigateur, version, numéro de
commande, et la capture de chaque téléphone.

## 3. Le dépôt : jetons de production et de sauvegarde, environnement `backup`

D'abord, la clé de sauvegarde locale est-elle celle du CI ? `repo` la pose
dans le nouvel environnement `backup` ; une autre clé chiffrerait les archives
nocturnes de la production avec une clé que le coffre n'a pas.

```sh
ls -l .shopctl/backup.key                            # sinon : la recopier depuis le coffre (0600)
N=$(gh run list --workflow nightly.yml --status success --limit 1 --json databaseId -q '.[0].databaseId')
gh run download "$N" -p 'nightly-pilote-certif-[0-9]*' -D "$J/nuit"      # les rapports du staging, pas les archives
ID=$(node -p 'require(process.argv[1]).id' "$(find "$J/nuit" -name backup.json | head -1)")
npm run -s shopctl -- backup pull "$ID" --env staging --json > "$E/cle-pull.json"; echo $?
npm run -s shopctl -- backup verify "$ID" --json > "$E/cle-verify.json"; echo $?
```

Attendu : `pull` et `verify` en `0`, et dans `cle-verify.json` le corps ouvert
avec la clé, chaque empreinte recalculée. Un refus de la clé arrête l'étape
ici : récupérer dans le coffre la clé qui ouvre l'archive.

Puis les jetons, sans écho, et le dépôt :

```sh
read -rs CLOUDFLARE_API_TOKEN_PRODUCTION && export CLOUDFLARE_API_TOKEN_PRODUCTION     # le jeton de déploiement de B
read -rs CLOUDFLARE_API_TOKEN_BACKUP && export CLOUDFLARE_API_TOKEN_BACKUP             # le jeton de sauvegarde de B
npm run -s shopctl -- repo --public --reviewer DamienGR --json > "$E/repo.json"; echo $?
unset CLOUDFLARE_API_TOKEN_PRODUCTION CLOUDFLARE_API_TOKEN_BACKUP
gh secret list                                       # MONITOR_CLOUDFLARE_API_TOKEN, MONITOR_CLOUDFLARE_ACCOUNT_ID
```

Attendu : `0` ; « staging : aucun jeton Cloudflare » en avertissement, son
secret laissé tel quel ; `production` réécrit avec le compte B, un relecteur
obligatoire ; `backup` créé, « limité à la branche main, sans relecteur »,
avec `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (B) et
`SHOPCTL_BACKUP_KEY`. Si les secrets `MONITOR_*` manquent :
`gh secret set MONITOR_CLOUDFLARE_API_TOKEN` (collé) et
`gh secret set MONITOR_CLOUDFLARE_ACCOUNT_ID --body "$COMPTE_B"`.

## 4. Les ressources de production sur B, et le domaine d'images

```sh
npm run -s shopctl -- provision --env production --dry-run --json > "$E/provision-simulation.json"; echo $?
npm run -s shopctl -- provision --env production --json > "$E/provision.json"; echo $?
git restore wrangler.jsonc
```

Attendu : `0` sur **Client (B)** ; la base et les trois buckets créés en
`eu`, vérifiés dans la juridiction ; fichiers et sauvegardes privés ; la règle
de conservation ; les 46 migrations ; `"demoCheckout": "create"` ; les
secrets internes reportés au premier déploiement.

Le domaine d'images : R2 → `minshop-pilote-certif-production-images` →
Settings → Custom Domains → **Add** → `images-certif-minshop.miijot.fr`.
Puis le déclarer :

```sh
git switch -c manifeste-domaine-images
sed -i 's/^  productionDomain: certif-minshop.miijot.fr$/&\n  imagesDomain: images-certif-minshop.miijot.fr/' client/client.yaml
git diff                                             # une ligne
npm run config:validate
git commit -am "Manifeste : domaine d'images de la production" && git push -u origin manifeste-domaine-images
gh pr create --fill && gh pr checks --watch && gh pr merge --merge
git switch main && git pull
npm run -s shopctl -- provision --env production --json > "$E/provision-2.json"; echo $?
git restore wrangler.jsonc
```

Attendu : `provision-2.json` en `0`, rien de créé, et
`exposure.images.domains` = `["images-certif-minshop.miijot.fr"]`.

## 5. Le mot de passe, avant tout déploiement

```sh
(umask 077; read -rs p; printf %s "$p" > "$J/pw-prod")   # le mot de passe de l'administration de production
npm run -s shopctl -- admin password --env production --json < "$J/pw-prod" > "$E/admin-password.json"; echo $?
git restore wrangler.jsonc
```

Attendu : `0`, `"action": "set"`, `"setupComplete": false`. Le haché n'est
écrit nulle part ailleurs que dans la base de B.

## 6. Le premier déploiement, par le workflow

```sh
gh workflow run deploy.yml -f shop=pilote-certif -f environment=production
sleep 10 && R=$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') && echo "$R"
```

Le job `Verify` passe, puis le run attend : GitHub → Actions → ce run →
**Review deployments** → `production` → **Approve and deploy**.

```sh
gh run watch "$R"; echo $?
gh run download "$R" -D "$E/deploy-1"
curl -s -o /dev/null -w 'setup %{http_code} %{redirect_url}\n' "$PROD/admin/setup" | tee "$E/apres-deploy-1.txt"
curl -s -o /dev/null -w 'vitrine %{http_code} %{redirect_url}\n' "$PROD/" | tee -a "$E/apres-deploy-1.txt"
```

Attendu : le run vert ; dans `deploy-1/…/deploy.json`, la sauvegarde
préalable envoyée dans `minshop-pilote-certif-production-backups`, le domaine
`certif-minshop.miijot.fr`, les deux secrets internes générés, et le test de
fumée vert avec ses avertissements « la boutique n'est pas encore
installée » — **sans** « l'assistant d'installation est ouvert » ;
`/admin/setup` en `303` vers `/admin/login`, la vitrine en `302` vers
l'assistant. Un test de fumée rouge sur une erreur TLS ou réseau (le premier
certificat) : relancer le workflow, rien n'est à défaire.

## 7. Installer et saisir sur B

`$PROD/admin/login`, le mot de passe de `$J/pw-prod`, puis l'assistant : nom
**Certif Minshop**, fuseau **Europe/Paris**. Dans Admin → Réglages :

- **E-mail** : Resend, la clé d'envoi, l'expéditeur
  `commandes@certif-minshop.miijot.fr` (jamais `onboarding@resend.dev`) ;
  **Envoyer un e-mail de test** vers l'adresse de Damien, et le recevoir ;
- **Protection anti-robots** : les deux clés du widget de production,
  activée ; se déconnecter et se reconnecter une fois, le widget passe ;
- **Paiements** : rien. La démonstration y apparaît désactivée ; la laisser
  ainsi ;
- **Pages** : les quatre pages légales relues, publiées, et dans le menu du
  pied de page (Navigation).

Le catalogue, saisi sur B par l'import, pas recopié depuis A :

`catalog import` vérifie que `wrangler.jsonc` décrit la production, mais ne
le rend pas, et chaque section l'a restauré : `provision` le rend, sans rien
créer, et confirme au passage les deux secrets que le premier déploiement a
posés.

```sh
npm run -s shopctl -- provision --env production --json > "$E/provision-3.json"; echo $?
C=test/fixtures/clients/pilot-fr/catalogue/catalog.csv
npm run -s shopctl -- catalog import $C --remote --env production --create-categories --dry-run --json > "$E/catalogue-simulation.json"; echo $?
npm run -s shopctl -- catalog import $C --remote --env production --create-categories --json > "$E/catalogue-1.json"; echo $?
npm run -s shopctl -- catalog import $C --remote --env production --create-categories --json > "$E/catalogue-2.json"; echo $?
git restore wrangler.jsonc
```

Attendu : `provision-3.json` en `0`, `AUTH_SECRET` et `SECRETS_KEK` « déjà
posé » ; le premier import crée 20 produits, 9 variantes, 4 catégories et
envoie 8 images dans le bucket de B ; le second a `statements: 0`.

Le second déploiement, pour un test de fumée sans avertissement :

```sh
gh workflow run deploy.yml -f shop=pilote-certif -f environment=production
sleep 10 && R=$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')
# approuver comme en section 6
gh run watch "$R"; echo $? && gh run download "$R" -D "$E/deploy-2"
```

## 8. Contrôler la boutique publique

```sh
curl -s "$PROD/api/products?limit=100" > "$J/produits.json"
F=$(node -p 'require(process.argv[1]).products.find((p) => p.image.startsWith("https://images-certif-minshop.miijot.fr/"))?.slug' "$J/produits.json")
I=$(node -p 'require(process.argv[1]).products.find((p) => p.slug === process.argv[2]).image' "$J/produits.json" "$F")
# Le panier ne dit la commande indisponible qu'avec un article : vide, il dit qu'il est vide.
A=$(node -p 'require(process.argv[1]).products.find((p) => p.slug === process.argv[2]).id' "$J/produits.json" "$F")
curl -s -o /dev/null -c "$J/panier.jar" -H "Origin: $PROD" --data "_action=add&product_id=$A" "$PROD/api/cart"
{
  echo "vitrine   $(curl -s -o /dev/null -w '%{http_code}' "$PROD/")"
  echo "catalogue $(curl -s -o /dev/null -w '%{http_code}' "$PROD/products")"
  echo "fiche     $(curl -s -o /dev/null -w '%{http_code}' "$PROD/products/$F")"
  echo "image     $(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$I")  ${I%%/media*}"
  echo "panier    $(curl -s -b "$J/panier.jar" "$PROD/cart" | grep -c 'momentanément indisponible')"
  echo "setup     $(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$PROD/admin/setup")"
} | tee "$E/servie.txt"
BASE_URL=$PROD npm run -s test:security:remote -- --limiteurs 2>&1 | tee "$E/porte-distante.txt"; echo $?
```

Attendu : la vitrine, le catalogue et la fiche en 200 ; l'image en
`200 image/png` sur `https://images-certif-minshop.miijot.fr` ; le panier
qui dit la commande indisponible (1) ; `/admin/setup` en 303 vers
`/admin/login`. La porte en `0`, tout vert, avec « aucun moyen de paiement
configuré : … à rejouer une fois Stripe configuré » sous le contrôle des
champs de carte, et la connexion refusée au plus tard à la sixième tentative.
L'adresse du poste ne peut plus se connecter à l'administration pendant un
quart d'heure.

## 9. Une nuit de sauvegarde, lancée à la main

```sh
gh workflow run nightly.yml
sleep 10 && N=$(gh run list --workflow nightly.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$N"; echo $?
gh run download "$N" -D "$E/nocturne-1"
ID=$(node -p 'require(process.argv[1]).id' "$(find "$E/nocturne-1" -name backup-production.json | head -1)")
npm run -s shopctl -- backup pull "$ID" --env production --json > "$E/pull-production.json"; echo $?
npm run -s shopctl -- backup verify "$ID" --json > "$E/verify-production.json"; echo $?
git restore wrangler.jsonc
```

Attendu : le run vert, ses six jobs ; `Production backup` a envoyé une
archive `pilote-certif-production-…` dans `-backups` de B et l'a vérifiée ;
rapatriée sur le poste, elle s'ouvre avec la clé du coffre. Les archives de
production restent sur le poste dans `backups/` : elles portent les données
des clients, les effacer après la vérification (`rm -rf "backups/$ID"`).

## 10. Détruire le staging de A

```sh
npm run -s shopctl -- destroy --env staging --confirm pilote-certif --dry-run --json > "$E/destroy-simulation.json"; echo $?
npm run -s shopctl -- destroy --env staging --confirm pilote-certif --json > "$E/destroy-1.json"; echo $?
```

Attendu : la simulation, sur **Agence (A)**, liste six ressources. Le premier
passage sort en `6` : Worker, namespace et bucket de fichiers partis ; R2
refuse le bucket d'images et celui des sauvegardes (code `10008`), et la
commande nomme **Settings → Empty Bucket**. Dans le tableau de bord de A :
R2 → `minshop-pilote-certif-staging-images` → Settings → **Empty Bucket**,
de même pour `…-staging-backups`. Puis :

```sh
npm run -s shopctl -- destroy --env staging --confirm pilote-certif --json > "$E/destroy-2.json"; echo $?
gh variable set STAGING_RETIRED --body "$(date -u +%F)"
gh api -X DELETE repos/DamienGR/shop-pilote-certif/environments/staging
echo "preview $(curl -s -o /dev/null -w '%{http_code}' "$PILOTE/")" | tee "$E/destroy-apres.txt"
git restore wrangler.jsonc
```

Attendu : `0`, `removed` = les deux buckets puis la base ; la variable posée ;
l'environnement `staging` et ses secrets supprimés ; la preview ne sert plus
la boutique (la page d'Access ou une erreur de Cloudflare, plus le Worker).

Et, à la main :

- Cloudflare A → My Profile → API Tokens : **révoquer** le jeton de staging ;
- Zero Trust (A) → Access : supprimer les deux applications de la preview
  (la preview et le contournement du webhook) et les jetons de service
  « pilote-certif » qui restent ;
- Stripe test → Développeurs → Webhooks : supprimer l'endpoint qui visait
  `preview.studiomaestro.fr/api/webhook` ;
- Resend → API Keys : révoquer la clé du staging, garder celle que les
  Réglages de B portent.

Une dernière nuit, à la main, pour voir le staging éteint :

```sh
gh workflow run nightly.yml
sleep 10 && N=$(gh run list --workflow nightly.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$N"; echo $?
gh run view "$N" > "$E/nocturne-2.txt"
```

Attendu : vert ; le job `Staging` sauté, la notice « Staging détruit le … » ;
`Production backup` et `Production error rate and quotas` verts.

## 11. Les preuves

```sh
grep -rl "$HOME" "$E" | xargs -r sed -i "s|$HOME|~|g"
grep -rl "$J" "$E" | xargs -r sed -i "s|$J|<tmp>|g"
grep -rl '/tmp/tmp\.' "$E" | xargs -r sed -i -E 's|/tmp/tmp\.[A-Za-z0-9]+|<tmp>|g'
grep -rc "$HOME" "$E" | grep -v ':0$'                # rien
rm -rf "$J"
git status --short                                   # client/certification seulement ; wrangler.jsonc intact
git switch -c certification-etape-9
git add client/certification && git commit -m "Certification, étape 9 : bascule sur le compte client"
git push -u origin certification-etape-9
gh pr create --fill
```

Dans `client/certification/etape-9/README.md`, ce qui ne laisse pas de
fichier : l'heure du premier déploiement et celle de la porte distante, le
délai du premier certificat, l'e-mail de test reçu (sans l'adresse), le
widget Turnstile vu à la connexion, l'état de la zone et de la preview après
la destruction, et tout ce qui a accroché.

## Ce qui coche le plan

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| `provision --env production` sur B, que le manifeste nomme | `provision.json`, `provision-2.json` | Client (B) ; ressources en `eu` ; 46 migrations ; démonstration coupée ; domaine d'images vu |
| contenus saisis sur B, pas recopiés depuis A | `catalogue-*.json`, README | catalogue importé sur B, réglages et pages saisis dans l'administration de B ; aucune restauration depuis A |
| `deploy --env production` par `Deploy`, sauvegarde préalable verte, approbation GitHub | `deploy-1/`, `deploy-2/`, README | deux runs approuvés ; l'archive préalable envoyée à chaque fois |
| domaine de production, domaine d'images, smoke test public vert | `deploy-2/…/deploy.json`, `servie.txt` | fumée verte sans avertissement ; l'image servie par `images-certif-minshop.miijot.fr` |
| la porte distante contre la production, `--limiteurs` | `porte-distante.txt` | tout vert ; la connexion refusée au plus tard à la sixième tentative |
| `shopctl destroy --env staging` sur A | `destroy-*.json`, `destroy-apres.txt`, `nocturne-2.txt` | staging parti ; le nocturne le dit et sauvegarde la production |

Et, au-delà des lignes : `admin-password.json` et `apres-deploy-1.txt`
(l'assistant jamais ouvert au public), `nocturne-1/`, `pull-production.json`
et `verify-production.json` (le RPO tenu sans staging), et la
[checklist de lancement](../operations/mise-en-ligne.md), livrable de
l'étape, exécutée une première fois.

## Ce qui ferme l'étape

La pull request des preuves du pilote verte. La donner dans le thread : les
rapports se relisent de là, la checklist se corrige d'après le README, puis
le plan est coché.
