# Étape 8 — Exploitation et résilience : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 8 du
[plan](plan.md#étape-8--exploitation-et-résilience) : le pilote monte en
`v0.3.12`, revient à sa version précédente puis repart en avant ; une archive
de son staging est rapatriée sur un second arbre et restaurée, chronomètre en
main, dans une production neuve sur le compte B, détruite ensuite ; puis, sur
le staging, la rotation de `AUTH_SECRET`, le mot de passe perdu, l'export et
l'anonymisation d'un acheteur, le monitor contre la vraie API, une image
supprimée à la main, et trois nuits du nocturne relues.

Elle a été répétée le 2026-10-20 dans un conteneur : le pilote en `v0.3.11`
servi en local avec trois commandes, les quatre clés du coffre et Turnstile
actif ; puis deux arbres sur un `wrangler` de doublure qui voit A et B.
Sauvegarde envoyée, rapatriée et contrôlée depuis le second arbre ;
production provisionnée sur B, restaurée, déployée, détruite ; rotation de
`AUTH_SECRET` et mot de passe perdu sur le Worker construit ; export et
anonymisation ; seuil du monitor abaissé contre une API GraphQL de doublure.
Tout est passé une fois les trois défauts corrigés.

## Ce que la répétition a trouvé

Corrigé dans `v0.3.12` (`docs/migrations/v0.3.12.md`) :

1. **`deploy` désignait la mauvaise version pour revenir en arrière.** Les six
   rapports de `deploy` du staging depuis l'étape 3 nomment tous la même
   `rollbackTo`, `1c01f15c…` : la plus ancienne des dix versions que liste
   `wrangler versions list`, de la plus ancienne à la plus récente. Un retour
   arrière suivant le rapport serait reparti des semaines en arrière. `deploy`
   lit désormais la version qui sert, avant de téléverser.
2. **La restauration sur B aurait échoué.** `restore` reversait les images
   dans les buckets que l'archive nomme, ceux du staging : absents de B, la
   restauration s'arrêtait après avoir écrit la base. Sur un même compte, elle
   aurait rempli le bucket du staging. Les objets suivent désormais leur
   liaison.
3. **Le coffre ne voyage pas, et rien ne le disait.** Les clés Stripe, Resend
   et Turnstile sont chiffrées avec la `SECRETS_KEK` du Worker de staging, qui
   ne le quitte jamais : restaurées sur B, elles sont présentes et illisibles.
   Turnstile actif avec une clé illisible, l'administration refuse toute
   connexion, sans autre message que « La vérification a échoué ». `restore` les
   nomme et donne la commande qui désactive Turnstile ; la connexion qui refuse
   reste telle quelle, la porte de sécurité l'exige.

Et le correctif de `destroy` trouvé au passage réel de l'étape 7 (le refus de
R2 relayé avec son code), que la section 5 voit à l'œuvre.

Quatre runbooks et la page d'exploitation corrigés dans la même version,
d'après ce que la répétition a montré : une commande `npx wrangler` brute
nomme son compte ; un retour arrière ramène les secrets de la version visée ;
la rotation de `SECRETS_KEK` désactive Turnstile d'abord ; celle de
`AUTH_SECRET` remet aussi à zéro les compteurs de connexion ; la restauration
vers un autre compte ; le mot de passe de staging, qui est aussi un secret du
nocturne.

Non répétés, faute de doublure : le retour arrière réel (son comportement est
lu dans le source de wrangler 4.149), le domaine personnalisé sur B et son
certificat, Access, les trois nuits du nocturne.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare A, staging du pilote | de nouvelles versions du Worker (`v0.3.12`, deux retours, la rotation) ; un `AUTH_SECRET` neuf ; une archive dans `-backups` ; un produit de test avec image, supprimé le jour même ; une commande de test anonymisée ; un nouveau mot de passe d'administration |
| Cloudflare B | **créé puis détruit** : Worker `minshop-pilote-certif-production` sur `certif-minshop.miijot.fr`, sa base, ses trois buckets en juridiction `eu`, son namespace KV de sessions, ses secrets internes, l'archive que `deploy` prend avant de migrer, un cron |
| Access (A) | un jeton de service « pilote-certif étape 8 », révoqué à la fin |
| GitHub `shop-pilote-certif` | la pull request de montée `socle/v0.3.12` ; le secret `MINSHOP_ADMIN_PASSWORD` de l'environnement staging, remplacé ; une pull request de preuves |
| Stripe test, Resend | un paiement de test et son e-mail de confirmation (section 8) |
| Stripe live | rien |

**La production de B est publique le temps de la section 4** : le catalogue de
test du staging sur `certif-minshop.miijot.fr`, sans paiement possible (la clé
Stripe y est illisible) et sans e-mail (la clé Resend aussi). Elle est
détruite à la section 5 : l'étape 9 la recrée, contenus saisis sur B et non
recopiés depuis A (ADR 0015).

## 0. Shell propre

Prérequis : le tag `v0.3.12`, publié par le workflow `Release` du socle.

```sh
P=<chemin>/shop-pilote-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
cd "$P" && nvm use 22
unset CLOUDFLARE_API_TOKEN
COMPTE_A=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
COMPTE_B=$(awk '/^  productionAccountId:/ {print $2}' client/client.yaml)
export CLOUDFLARE_ACCOUNT_ID=$COMPTE_A
export PILOTE="https://$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)"
export PROD="https://$(awk '/^  productionDomain:/ {print $2}' client/client.yaml)"
E="$P/client/certification/etape-8" && mkdir -p "$E"
J=$(mktemp -d)                                       # hors du dépôt : mot de passe et cookies
echo "$CLOUDFLARE_ACCOUNT_ID $COMPTE_B $PILOTE $PROD"
```

Zero Trust (compte A) → Access → Service credentials → **Créer un jeton de
service** « pilote-certif étape 8 », la durée la plus courte proposée, ajouté
à la politique **Service Auth** de l'application de preview.

```sh
read -rs CF_ACCESS_CLIENT_ID && export CF_ACCESS_CLIENT_ID          # coller, Entrée : rien à l'écran
read -rs CF_ACCESS_CLIENT_SECRET && export CF_ACCESS_CLIENT_SECRET
ac() { curl -s -H "cf-access-client-id: $CF_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $CF_ACCESS_CLIENT_SECRET" "$@"; }
ac -o /dev/null -w '%{http_code}\n' "$PILOTE/"                           # 200
(umask 077; read -rs p; printf %s "$p" > "$J/pw")    # le mot de passe d'administration du staging
```

Le mot de passe passe par un fichier de `$J`, jamais en argument :
`curl --data-urlencode "password@$J/pw"` le lit de là.

## 1. Monter le pilote en `v0.3.12`, et le rapport qui dit d'où il vient

```sh
npm run shopctl -- core status                       # v0.3.9
npm run shopctl -- core upgrade --to v0.3.12 --open-pr
gh pr checks socle/v0.3.12 --watch
gh pr merge socle/v0.3.12 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.12
npx wrangler deployments status --name minshop-pilote-certif-staging --json > "$E/deploiement-avant.json"
npm run -s shopctl -- deploy --env staging --json > "$E/deploy-v0.3.12.json"; echo $?
node -e 'const avant = require(process.argv[1]).versions[0].version_id, r = require(process.argv[2]).rollbackTo; console.log(r === avant ? `rollbackTo ${r} : la version qui servait` : `ÉCART : ${r}, alors que ${avant} servait`)' "$E/deploiement-avant.json" "$E/deploy-v0.3.12.json"
```

Attendu : la pull request verte, avec les notes de `v0.3.10` à `v0.3.12`,
aucune migration, rien à faire dans le dépôt. `deploy` en `0`, et `rollbackTo`
égal à la version qui servait avant lui : celle du déploiement `v0.3.9` de
l'étape 6, plus `1c01f15c…`.

## 2. Revenir en arrière, puis repartir en avant

Le Worker de `v0.3.12` est celui de `v0.3.9` (rien n'a changé dans `src/`
depuis) : le retour se lit dans la version servie, pas dans les pages.

```sh
W=minshop-pilote-certif-staging
sert() { npx wrangler deployments status --name "$W" --json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).versions.map((v) => `${v.version_id} ${v.percentage} %`).join(", ")'; }
AVANT=$(node -p 'require(process.argv[1]).rollbackTo' "$E/deploy-v0.3.12.json")
APRES=$(npx wrangler deployments status --name "$W" --json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).versions[0].version_id')
{
  echo "$(date -u +%FT%TZ) sert $(sert)"
  npx wrangler rollback "$AVANT" --name "$W" --message "certification étape 8 : retour arrière" >&2
  echo "$(date -u +%FT%TZ) sert $(sert)  vitrine $(ac -o /dev/null -w '%{http_code}' "$PILOTE/")  catalogue $(ac -o /dev/null -w '%{http_code}' "$PILOTE/products")"
  npx wrangler rollback "$APRES" --name "$W" --message "certification étape 8 : retour en avant" >&2
  echo "$(date -u +%FT%TZ) sert $(sert)  vitrine $(ac -o /dev/null -w '%{http_code}' "$PILOTE/")  catalogue $(ac -o /dev/null -w '%{http_code}' "$PILOTE/products")"
} | tee "$E/rollback.txt"
```

Wrangler demande confirmation à chaque retour : **oui**. S'il annonce que des
secrets ont changé depuis la version visée (code 10220) et demande s'il faut
passer outre, répondre **non** et le noter : aucun secret n'a changé entre les
deux, c'est la rotation de la section 6 qui en change un, et c'est pour cela
qu'elle vient après.

Attendu : trois lignes ; `$APRES` à 100 %, puis `$AVANT` à 100 % avec la
vitrine et le catalogue en 200, puis `$APRES` de nouveau, en 200.

## 3. Trois nuits de nocturne, puis une archive prise et rapatriée ailleurs

Le RPO se lit dans l'historique : chaque nuit, le nocturne sauvegarde le
staging dans son bucket `-backups` et restaure l'archive dans une base jetable.

```sh
gh run list --workflow Nightly --event schedule --limit 5 --json databaseId,createdAt \
  | node -e 'for (const r of JSON.parse(require("fs").readFileSync(0, "utf8"))) console.log(r.databaseId, r.createdAt)' > "$J/runs.txt"
while read -r id quand; do
  gh run view "$id" --json jobs | node -e '
    const steps = JSON.parse(require("fs").readFileSync(0, "utf8")).jobs.flatMap((j) => j.steps ?? []);
    const vus = steps.filter((s) => s.name === "Back up staging" || s.name === "Restore it into a throwaway database");
    console.log(process.argv[1], process.argv[2], vus.map((s) => `${s.name} : ${s.conclusion}`).join(" ; ") || "étapes absentes");' "$id" "$quand"
done < "$J/runs.txt" | tee "$E/nocturnes.txt"
```

Attendu : trois nuits consécutives avec les deux étapes en `success`. Le run
entier peut être rouge pour une autre raison (les deux rouges connus) : la
ligne du plan ne porte que sur ces deux étapes. Pour chacune des trois nuits
retenues : `gh run download <id> -D "$E/nocturne-<date>"` garde ses rapports
(`backup.json`, `restore.json`, `monitor.json`), qui ne portent aucune donnée.

Puis l'archive de la campagne, prise d'ici :

```sh
npm run -s shopctl -- backup keygen --json > "$E/keygen.json"; echo $?
npm run -s shopctl -- backup --env staging --upload --json > "$E/backup.json"; echo $?
ID=$(node -p 'require(process.argv[1]).id' "$E/backup.json")
echo "$ID"
```

Attendu : `keygen` en `4`, « .shopctl/backup.key existe déjà et n'est pas
remplacé » : c'est la clé de l'étape 2, celle que `shopctl repo` a posée dans
GitHub, et c'est la garantie qu'on veut voir. La sauvegarde en `0`, envoyée
dans `minshop-pilote-certif-staging-backups`.

Le second arbre est un autre poste en tout sauf le matériel : un clone neuf,
sans archive et sans clé, la clé collée depuis le coffre où elle est rangée.

```sh
Q=$(mktemp -d)/shop-pilote-certif
git clone -q "$(git remote get-url origin)" "$Q"
cd "$Q" && npm ci && npm ci --prefix mcp
unset CLOUDFLARE_ACCOUNT_ID                          # le manifeste nomme A pour staging, B pour production
read -rs SHOPCTL_BACKUP_KEY && export SHOPCTL_BACKUP_KEY             # depuis le coffre, pas depuis "$P"
npm run -s shopctl -- backup pull "$ID" --env staging --json > "$E/pull.json"; echo $?
npm run -s shopctl -- backup verify "$ID" --json > "$E/verify.json"; echo $?
```

Attendu : `0` deux fois ; le pull compare taille et empreinte du corps et
chaque objet ; le verify ouvre le corps (« corps ouvert ») et compte les lignes
table par table, « Archive complète et cohérente ». Si la clé n'est pas dans le
coffre, `export SHOPCTL_BACKUP_KEY="$(cat "$P/.shopctl/backup.key")"` fait la
même chose, et c'est une trouvaille pour le README des preuves : une clé
rangée sur un seul poste perd toutes les archives avec lui.

## 4. Restauration chronométrée dans une production neuve sur B

Toujours dans `$Q`. Le chronomètre part au premier `provision` et s'arrête au
test de fumée vert. `deploy` refait `npm run verify` : c'est la commande du
runbook, et son temps compte.

```sh
t() { echo "$(date -u +%FT%TZ) $1" | tee -a "$E/chrono.txt"; }
t "début : provision --env production sur B"
npm run -s shopctl -- provision --env production --json > "$E/provision-b.json"; echo $?
t "provisionné"
npm run -s shopctl -- restore --env production --from "$ID" --allow-production --confirm pilote-certif --json > "$E/restore-b.json"; echo $?
t "restauré"
npm run -s shopctl -- deploy --env production --yes --smoke-wait 600 --json > "$E/deploy-b.json"; echo $?
t "déployé, test de fumée"
```

Attendu, dans l'ordre :

- `provision` en `0` sur **Client (B)**, que le manifeste nomme : la base, les
  trois buckets en `eu`, les 46 migrations. Si R2 n'est pas activé sur B, il
  échoue au premier bucket : l'activer, relancer ;
- `restore` en `0` : l'avertissement « l'archive vient du compte Agence (A) »,
  les instructions appliquées, les images reversées dans
  `minshop-pilote-certif-production-images` (le correctif 2), « 26 table(s)
  identiques à l'archive, empreinte pour empreinte ». Puis la section
  **Coffre** : les quatre clés qui ne s'ouvrent pas, et la commande qui
  désactive Turnstile. Une archive à laquelle manque une image s'arrête avant
  d'écrire ; `--allow-missing-media` l'accepte, à noter ;
- `deploy` en `0` : `npm run verify`, l'archive préalable envoyée dans
  `-backups` de B, les migrations (rien à appliquer), le build, le
  téléversement sur `certif-minshop.miijot.fr`, les deux secrets internes
  générés, cinq contrôles verts. Le premier certificat du domaine peut
  prendre quelques minutes : si le test de fumée échoue sur une erreur réseau
  ou TLS, attendre une minute et relancer
  `npm run -s shopctl -- deploy --env production --yes --skip-verify --skip-build --smoke-wait 600 --json > "$E/deploy-b-2.json"; t "déployé, relance"`,
  le chronomètre continue.

La boutique est servie. L'administration, elle, refuse encore : c'est le
coffre. Le constater, appliquer la commande que `restore` a donnée, constater
l'ouverture :

```sh
connexion() { curl -s -c "$J/jar-b" -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $PROD" -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "password@$J/pw" --data-urlencode 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' "$PROD/admin/login"; }
echo "avant le remède  $(connexion)" | tee "$E/coffre-b.txt"           # 200 : refusée
CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler d1 execute minshop-pilote-certif-production-db --remote --command "DELETE FROM settings WHERE key = 'turnstile_enabled'"
echo "après le remède  $(connexion)" | tee -a "$E/coffre-b.txt"        # 303 …/admin
t "administration ouverte"
K=$(CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler d1 execute minshop-pilote-certif-production-db --remote --json --command "SELECT image_key FROM media LIMIT 1" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0]?.image_key ?? ""')
{
  echo "vitrine   $(curl -s -o /dev/null -w '%{http_code}' "$PROD/")"
  echo "catalogue $(curl -s -o /dev/null -w '%{http_code}' "$PROD/products")  produits $(curl -s "$PROD/api/products?limit=100" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).total')"
  echo "image     $(curl -s -o /dev/null -w '%{http_code} %{content_type}' "$PROD/images/$K")"
} | tee "$E/servie-b.txt"
```

Attendu : « avant » en `200` (la page de connexion, « La vérification a
échoué »), « après » en `303` vers `/admin` ; la vitrine et le catalogue en
200 avec les produits du staging ; une image en `200 image/png`, lue dans le
bucket de B. Le RTO va de la ligne « début » de `chrono.txt` à la ligne
« déployé » du passage vert, la relance s'il y en a eu une : il doit rester
sous 60 minutes.

Les clés ne se ressaisissent pas ici : la boutique part à la section suivante.

## 5. Détruire la production de B

```sh
npm run -s shopctl -- destroy --env production --confirm pilote-certif --dry-run --json > "$E/destroy-b-simulation.json"; echo $?
npm run -s shopctl -- destroy --env production --confirm pilote-certif --yes --json > "$E/destroy-b-1.json"; echo $?
```

Attendu : la simulation liste six ressources (Worker, namespace des sessions,
trois buckets, base). Le premier passage sort en `6` : le Worker, le namespace
et le bucket de fichiers partent ; R2 refuse le bucket d'images (les images
restaurées) et celui des sauvegardes (l'archive de `deploy`), cette fois avec
sa propre phrase et son code `10014` ; la base reste.

Vider les deux buckets :

```sh
CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler d1 execute minshop-pilote-certif-production-db --remote --json --command "SELECT image_key FROM media" | node -e 'for (const r of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results) console.log(r.image_key)' > "$J/cles-images.txt"
while read -r k; do CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler r2 object delete "minshop-pilote-certif-production-images/$k" --remote -J eu; done < "$J/cles-images.txt"
for d in backups/pilote-certif-production-*/; do     # une archive par passage de deploy, gardée ici aussi
  ID2=$(basename "$d")
  (cd "backups/$ID2" && find . -type f | sed 's|^\./||') | while read -r f; do CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler r2 object delete "minshop-pilote-certif-production-backups/$ID2/$f" --remote -J eu; done
done
npm run -s shopctl -- destroy --env production --confirm pilote-certif --yes --json > "$E/destroy-b-2.json"; echo $?
echo "production $(curl -s -o /dev/null -w '%{http_code}' "$PROD/")" | tee "$E/destroy-b-apres.txt"
```

Attendu : `0`, `removed` = les deux buckets puis la base ; plus de boutique
sur le domaine. Dans le tableau de bord de B : Workers & Pages vide, et la
zone ne garde aucun enregistrement pour `certif-minshop` (un domaine
personnalisé part avec son Worker) ; s'il en reste un, le supprimer et le
noter, sans quoi l'étape 9 le trouvera en travers. Si R2 refuse encore un
bucket, le tableau de bord le vide (R2 → le bucket → tout sélectionner →
Supprimer), puis la même commande.

Le second arbre a fini son office :

```sh
cd "$P" && export CLOUDFLARE_ACCOUNT_ID=$COMPTE_A
unset SHOPCTL_BACKUP_KEY && rm -rf "$(dirname "$Q")"
```

## 6. Rotation de `AUTH_SECRET`

```sh
etat() { echo "$(date -u +%TZ) admin $(ac -b "$J/jar" -o /dev/null -w '%{http_code} %{redirect_url}' "$PILOTE/admin")  vitrine $(ac -o /dev/null -w '%{http_code}' "$PILOTE/")  catalogue $(ac -o /dev/null -w '%{http_code}' "$PILOTE/products")  panier $(ac -o /dev/null -w '%{http_code}' "$PILOTE/cart")"; }
connexion() { ac -c "$J/jar" -o /dev/null -w '%{http_code} %{redirect_url}\n' -H "Origin: $PILOTE" -H 'Content-Type: application/x-www-form-urlencoded' --data-urlencode "password@$J/pw" --data-urlencode 'cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX' "$PILOTE/admin/login"; }
{
  echo "connexion $(connexion)"
  etat
  openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET --name minshop-pilote-certif-staging >&2
  sleep 30
  etat
  echo "connexion $(connexion)"
  etat
} | tee "$E/rotation-auth-secret.txt"
```

Attendu : connexion en `303` vers `/admin`, puis l'administration en `200` ;
après la rotation, l'administration en `303` vers `/admin/login` (la session
est tombée), la vitrine, le catalogue et le panier en `200` ; une nouvelle
connexion en `303`, l'administration de nouveau en `200`. Rien d'autre ne
dépend de ce secret sur cette boutique (les comptes clients sont coupés). Si
la connexion répond `200`, Turnstile garde le staging avec un widget réel et
non les clés de test : faire les deux connexions dans le navigateur, et noter
les codes de `etat` seuls.

Une version antérieure à cette rotation ramènerait l'ancien secret : les
retours arrière de la section 2 sont faits, et il n'y en a plus à faire.

## 7. Mot de passe d'administration perdu

Le runbook [mot de passe admin](../operations/runbooks/mot-de-passe-admin.md),
tel qu'il est écrit, sur le staging. Ouvrir `$PILOTE/admin/setup` dans le
navigateur, passer Access, et **garder l'onglet** avant de lancer :

```sh
npm run shopctl -- provision --env staging           # rend wrangler.jsonc du staging, ne crée rien
scripts/admin-reset.sh --remote
```

**Tout de suite**, recharger l'onglet : l'assistant s'ouvre, nom et fuseau
préremplis, à garder ; un mot de passe neuf rangé dans le gestionnaire. Puis :

```sh
(umask 077; read -rs p; printf %s "$p" > "$J/pw")    # le nouveau
{
  echo "assistant   $(ac -o /dev/null -w '%{http_code} %{redirect_url}' "$PILOTE/admin/setup")"
  echo "ancienne session : $(etat)"
  echo "connexion $(connexion)"
  etat
} | tee "$E/mot-de-passe.txt"
gh secret set MINSHOP_ADMIN_PASSWORD --env staging     # coller le nouveau
```

Attendu : `admin-reset.sh` « Admin password cleared on the DEPLOYED store » ;
l'assistant refermé (`303` vers `/admin/login`), l'ancienne session tombée
(`303`), la nouvelle connexion en `303` puis l'administration en `200`. Le
secret du nocturne remplacé, sans quoi l'e-mail de test de la nuit suivante
échoue. Ce qui a accroché, ou ce qui diffère du runbook, va dans le README
des preuves : c'est ce qui le corrige.

## 8. Export puis anonymisation d'un acheteur de test

Un achat de test sur le staging, dans le navigateur : un produit, la carte
`4242 4242 4242 4242`, et une adresse à vous marquée pour l'occasion
(`<vous>+etape8@…`). Relever le numéro de commande. L'adresse ne figure dans
aucune preuve.

```sh
read -r ACHETEUR                                     # l'adresse de l'achat
sans() { node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); delete r.file; console.log(JSON.stringify(r, null, 2))'; }
npm run -s shopctl -- privacy export --env staging --email "$ACHETEUR" --json | sans > "$E/privacy-export.json"; echo $?
ls -l privacy/                                       # le document, 0600
npm run -s shopctl -- privacy anonymize --env staging --email "$ACHETEUR" --dry-run
npm run -s shopctl -- privacy anonymize --env staging --email "$ACHETEUR" --confirm pilote-certif --json > "$E/privacy-anonymize.json"; echo $?
npm run -s shopctl -- privacy export --env staging --email "$ACHETEUR" --json | sans > "$E/privacy-export-apres.json"; echo $?
grep -c "$ACHETEUR" "$E"/privacy-*.json             # 0 partout
rm -f privacy/pilote-certif-staging-*.json && unset ACHETEUR
```

Attendu : l'export en `0`, des lignes dans `orders`, `order_items` et
`order_guest_access`, les colonnes retenues nommées, et les identifiants
Stripe signalés comme une demande à faire chez Stripe ; l'anonymisation en
`0`, « plus rien sous cette adresse » ; le second export en `0` avec
`found: false`. Dans l'administration, la commande garde son numéro, ses
montants et sa TVA, sous une adresse `anonymise-…@exemple.invalid`, et son
pays seul pour adresse ; son lien de suivi ne s'ouvre plus.

## 9. Le monitor contre la vraie API, et un seuil abaissé

Avec le jeton API de staging (« Account Analytics » en lecture), le temps de
ces deux commandes :

```sh
read -rs CLOUDFLARE_API_TOKEN                        # coller, Entrée : rien à l'écran
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npm run -s shopctl -- monitor --env staging --hours 24 --json > "$E/monitor.json"; echo $?
sed -i 's/quotaShare: 0.7,/quotaShare: 0.0001,/' shopctl/src/commands/monitor.mjs && git diff --stat shopctl/
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npm run -s shopctl -- monitor --env staging --hours 24 --json > "$E/monitor-seuil-abaisse.json"; echo $?
git restore shopctl/src/commands/monitor.mjs && unset CLOUDFLARE_API_TOKEN
node -e 'for (const c of require(process.argv[1]).checks ?? []) console.log(c.ok ? "✓" : "✗", c.name, "—", c.detail)' "$E/monitor-seuil-abaisse.json"
```

Attendu : `0`, puis `6` avec les quotas du plan gratuit en ✗, chacun avec
le seuil abaissé dans son détail ; le fichier restauré (`git status` propre).
Les champs que la doublure suppose étaient déjà là à l'étape 6 (`monitor.json`
de ses preuves) ; la ligne demande en plus qu'un seuil franchi fasse échouer
le run.

## 10. Une image supprimée à la main

À faire **dans la journée** et à nettoyer avant 03:17 UTC : une archive dont
une image manque n'est pas restaurée sans `--allow-missing-media`, et le
nocturne échouerait la nuit suivante, ce qui est voulu.

Dans l'administration du staging → Produits → **Nouveau produit** : « Croix de
test média », URL `croix-test-media`, prix 1,00, stock 1, actif, **une image**
(`test/fixtures/clients/pilot-fr/catalogue/photos/tee-coton.png`) →
**Créer le produit**.

```sh
K=$(npx wrangler d1 execute minshop-pilote-certif-staging-db --remote --json --command "SELECT image_key FROM products WHERE slug = 'croix-test-media'" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0].image_key')
pages() {
  for p in /products/croix-test-media /products /api/products/croix-test-media "/images/$K" "/images/$K?$1"; do
    echo "$p $(ac -o /dev/null -w '%{http_code} %{content_type}' "$PILOTE$p")"
  done
}
{
  echo "-- avant"; pages avant
  npx wrangler r2 object delete "minshop-pilote-certif-staging-images/$K" --remote -J eu >&2
  echo "-- après suppression"; pages apres
} | tee "$E/media-supprime.txt"
```

Attendu : tout en `200` avant ; après, la fiche, le catalogue et l'API en
`200`, l'image demandée avec `?apres` en `404 text/plain` : la page dégrade,
sans erreur. L'image sans paramètre peut répondre encore `200` : la route la
garde un an dans le cache de Cloudflare, là où elle a déjà été servie. Dans
Workers → `minshop-pilote-certif-staging` → Observability, aucune exception sur
ces requêtes.

Nettoyer : Produits → « Croix de test média » → **Supprimer**, puis Médias →
l'image → **Supprimer** (elle part de la base ; l'objet n'existe déjà plus).

```sh
npx wrangler d1 execute minshop-pilote-certif-staging-db --remote --json --command "SELECT COUNT(*) AS n FROM media WHERE image_key = '$K'" > "$E/media-nettoye.json"     # n = 0
```

## 11. Les preuves

Les rapports nomment des chemins de ce poste. Les masquer avant le commit :

```sh
grep -rl "$HOME" "$E" | xargs -r sed -i "s|$HOME|~|g"
grep -rl "$J" "$E" | xargs -r sed -i "s|$J|<tmp>|g"
grep -rl '/tmp/tmp\.' "$E" | xargs -r sed -i -E 's|/tmp/tmp\.[A-Za-z0-9]+|<tmp>|g'
grep -rc "$HOME" "$E" | grep -v ':0$'                # rien
rm -rf "$J"
git switch -c certification-etape-8
git add client/certification && git commit -m "Certification, étape 8 : exploitation et résilience"
git push -u origin certification-etape-8
gh pr create --fill
```

Dans `client/certification/etape-8/README.md`, ce qui ne laisse pas de
fichier : le temps de chaque étape de la restauration et le RTO, ce que wrangler
a demandé aux deux retours, le domaine de B après la destruction, ce qui a
différé des runbooks (sections 2 et 4 à 7), et tout ce qui a accroché.

Enfin, Zero Trust → Access → Service credentials → « pilote-certif étape 8 »
→ **révoquer**, et `unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET CLOUDFLARE_ACCOUNT_ID`.

## Ce qui coche le plan

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| `backup keygen`, `backup --upload`, `backup pull` depuis un autre poste, `backup verify` | `keygen.json`, `backup.json`, `pull.json`, `verify.json` | la clé existante gardée (4) ; l'archive envoyée ; rapatriée dans un clone neuf, la clé venue du coffre ; « Archive complète et cohérente » |
| restauration chronométrée sur B, < 60 minutes, prouvée table par table | `chrono.txt`, `provision-b.json`, `restore-b.json`, `deploy-b.json`, `servie-b.txt`, `coffre-b.txt` | sur Client (B) ; 26 tables identiques ; images dans les buckets de B ; fumée verte ; RTO sous 60 minutes |
| RPO ≤ 24 heures : trois nuits | `nocturnes.txt`, `nocturne-*/` | trois nuits consécutives, sauvegarde et restauration en `success` |
| `monitor` contre la vraie API, seuil abaissé | `monitor.json`, `monitor-seuil-abaisse.json` | `0`, puis `6` sur les quotas |
| média supprimé à la main : dégradation sans erreur | `media-supprime.txt`, `media-nettoye.json` | fiche en 200, image en 404 ; nettoyé |
| rollback vers la version précédente, puis retour | `deploiement-avant.json`, `deploy-v0.3.12.json`, `rollback.txt` | `rollbackTo` = la version qui servait ; elle à 100 %, puis `v0.3.12` à 100 %, la vitrine en 200 |
| rotation de `AUTH_SECRET` : les sessions tombent, rien d'autre | `rotation-auth-secret.txt` | admin en 303 après, vitrine, catalogue, panier en 200 ; reconnexion |
| mot de passe perdu, selon le runbook | `mot-de-passe.txt` | assistant refermé, ancienne session tombée, nouvelle connexion |
| `privacy export` puis `anonymize` | `privacy-export.json`, `privacy-anonymize.json`, `privacy-export-apres.json` | des lignes, puis plus rien sous l'adresse |

Et, au-delà des lignes : `destroy-b-*.json` (la production de B partie, le
refus de R2 relayé avec son code), la **preuve de restauration** que le plan
attend comme livrable.

## Ce qui ferme l'étape

La pull request des preuves du pilote verte. La donner dans le thread : les
rapports se relisent de là, les runbooks se corrigent d'après le README, puis
le plan est coché.
