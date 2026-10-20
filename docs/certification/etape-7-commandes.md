# Étape 7 — Isolation de deux boutiques déployées : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 7 du
[plan](plan.md#étape-7--isolation-de-deux-boutiques-déployées) : `canari-certif`
rejoint `pilote-certif` sur le compte A, les deux se répondent chacune sur son
origine, un produit de l'une n'apparaît pas dans l'autre, l'import croisé est
refusé, puis la canari est supprimée sans rien emporter du pilote.

La canari porte encore `v0.3.2` (étape 2) ; elle monte en **`v0.3.10`**, la
version qui corrige ce que la répétition a trouvé. Le pilote reste en `v0.3.9` :
deux versions du socle côte à côte sur un compte, c'est aussi une ligne du
§8.3.

Elle a été répétée le 2026-10-19 dans un conteneur : une canari créée depuis
`v0.3.1` et montée en `v0.3.2` comme à l'étape 2, puis en `v0.3.9` d'un seul
saut (fusion sans conflit, `npm run verify` de la boutique vert) ; un pilote en
`v0.3.9` avec son catalogue témoin ; un `wrangler` de doublure qui voit deux
comptes ; le Worker construit de la canari servi en local pour le test de
fumée. Provision, déploiement, import croisé, sauvegarde, puis `destroy` avec
deux buckets à vider : tout est passé, une fois les quatre défauts corrigés.

## Ce que la répétition a trouvé

Corrigé dans `v0.3.10` (`docs/migrations/v0.3.10.md`) :

1. **Le premier déploiement de la canari finissait rouge.** Sans Access devant
   elle, une boutique pas encore installée renvoie chaque page vers
   `/admin/setup` ; le test de fumée lisait ces redirections comme une vitrine
   absente (« la liaison D1 est le premier suspect ») et `deploy` sortait en
   code 6 après le téléversement. Cela vaut pour tout staging sur workers.dev
   et pour **la première production de chaque boutique** : l'étape 9 l'aurait
   rencontré. C'est désormais un avertissement qui dit l'état de la boutique.
2. **`destroy` laissait le namespace KV des sessions.** Wrangler le crée au
   premier déploiement, sous `<worker>-session`, à partir d'une liaison que
   l'adaptateur Astro ajoute au build ; aucun fichier de la boutique ne le
   nomme, et `destroy` ne le cherchait pas. « Tout part » était faux.
3. **La commande proposée pour vider un bucket ne vidait rien.** Sans
   `--remote`, `wrangler r2 object delete` agit sur le simulateur local depuis
   wrangler 4, répond « Delete complete », et le bucket du compte reste plein.
4. **Le refus de l'import croisé conseillait un remède sans issue** :
   `prepare-client.mjs --env` rend les bons noms autour d'un identifiant de
   base factice. Il renvoie désormais vers `shopctl provision`, qui rend
   l'identifiant réel sans rien créer.

Non répété, faute de doublure : Access, la lecture des liaisons déployées
(`deployments status`, `versions view`), les limiteurs de Cloudflare.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare A | **créé puis détruit** : Worker `minshop-canari-certif-staging` sur workers.dev, sa base, ses trois buckets en juridiction `eu`, son namespace KV de sessions, ses secrets internes, une archive de sauvegarde. Un second cron (toutes les cinq minutes) le temps de l'étape : le plan gratuit en accepte cinq par compte |
| Staging `pilote-certif` (A) | un produit de test, supprimé à la fin ; rien d'autre |
| Access (A) | un jeton de service « pilote-certif étape 7 », révoqué à la fin |
| GitHub `shop-canari-certif` | la pull request de montée `socle/v0.3.10` ; une pull request de preuves |
| GitHub `shop-pilote-certif`, compte B, Stripe, Resend | rien |

La canari est publique le temps de l'étape : workers.dev, sans Access, comme le
témoin `canary-minimal`. Son assistant `/admin/setup` reste ouvert entre le
déploiement et la section 2 : la faire **tout de suite**.

## 0. Shell propre

Prérequis : le tag `v0.3.10`, publié par le workflow `Release` du socle.

```sh
P=<chemin>/shop-pilote-certif
C=<chemin>/shop-canari-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
git -C "$C" switch main && git -C "$C" pull && git -C "$C" status --short     # rien
git -C "$C" remote get-url core || git -C "$C" remote add core https://github.com/DamienGR/minshop-platform.git
cd "$C" && nvm use 22
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' "$P/client/client.yaml")
export PILOTE="https://$(awk '/^  stagingDomain:/ {print $2}' "$P/client/client.yaml")"
E="$C/client/certification/etape-7" && mkdir -p "$E"
echo "$CLOUDFLARE_ACCOUNT_ID $PILOTE"                # A et la preview du pilote
```

La canari ne déclare pas de compte, exprès (étape 2) : `CLOUDFLARE_ACCOUNT_ID`,
pris dans le manifeste du pilote, est ce qui la pose sur A. `provision` le dit
par un avertissement ; c'est attendu.

Zero Trust (compte A) → Access → Service credentials → **Créer un jeton de
service** « pilote-certif étape 7 », la durée la plus courte proposée, ajouté
à la politique **Service Auth** de l'application de preview.

```sh
read -rs CF_ACCESS_CLIENT_ID && export CF_ACCESS_CLIENT_ID          # coller, Entrée : rien à l'écran
read -rs CF_ACCESS_CLIENT_SECRET && export CF_ACCESS_CLIENT_SECRET
ac() { curl -s -H "cf-access-client-id: $CF_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $CF_ACCESS_CLIENT_SECRET" "$@"; }
ac -o /dev/null -w '%{http_code}\n' "$PILOTE/"                           # 200
```

## 1. Monter la canari en `v0.3.10`

```sh
cd "$C"
npm run shopctl -- core status                       # v0.3.2, huit versions de retard
npm run shopctl -- core upgrade --to v0.3.10 --open-pr
gh pr checks socle/v0.3.10 --watch
gh pr merge socle/v0.3.10 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.10
```

Attendu : la pull request verte, avec les notes de `v0.3.3` à `v0.3.10` et
trois migrations additives (0043 à 0045), qui partiront avec le provision.
Rien à faire dans le dépôt. En répétition, le saut de `v0.3.2` à `v0.3.9`
fusionnait sans conflit et la boutique passait toutes ses portes.

## 2. Provisionner et déployer la canari

```sh
npm run shopctl -- provision --env staging --dry-run
npm run -s shopctl -- provision --env staging --json > "$E/provision-canari.json"; echo $?
npm run -s shopctl -- deploy --env staging --json > "$E/deploy-canari-1.json"; echo $?
export CANARI=$(node -p 'require(process.argv[1]).origin' "$E/deploy-canari-1.json")
echo "$CANARI"                                       # https://minshop-canari-certif-staging.<sous-domaine>.workers.dev
```

Attendu : `0` deux fois. `provision` : quatre créations (la base et trois
buckets), la juridiction `eu` relue, `-files` et `-backups` privés, la règle de
90 jours, les 45 migrations. `deploy` : `npm run verify` et le build, puis
quatre avertissements au test de fumée — `/`, `/products` et `/robots.txt`
« renvoie vers /admin/setup : la boutique n'est pas encore installée », et
l'assistant ouvert. Si le test de fumée échoue sur une erreur réseau ou un 404
« There is nothing here yet », workers.dev n'a pas encore propagé le nom :
attendre une minute et relancer **avant** l'assistant, pour que le rapport
garde les avertissements que la ligne demande :

```sh
mv "$E/deploy-canari-1.json" "$E/deploy-canari-1-propagation.json"
npm run -s shopctl -- deploy --env staging --skip-verify --skip-build --json > "$E/deploy-canari-1.json"; echo $?
```

Le passage réel l'a rencontré : `/` et `/products` en 404, `/robots.txt` et
l'assistant déjà en 200, code 6 ; une minute plus tard, la relance sortait en
`0` avec ses quatre avertissements. Les 404 étaient la réponse de Cloudflare
(« There is nothing here yet »), le robots.txt aussi : depuis `v0.3.11`, `deploy` les
reconnaît et attend la propagation lui-même, deux minutes au plus ; la relance
n'est plus utile que s'il sort en 6 en nommant Cloudflare.

**Tout de suite**, dans le navigateur : `$CANARI/admin/setup`. Nom « Canari
Certif », fuseau Europe/Paris, un mot de passe neuf rangé dans le
gestionnaire, **sans** le catalogue de démonstration. Puis :

```sh
npm run -s shopctl -- deploy --env staging --skip-verify --skip-build --json > "$E/deploy-canari-2.json"; echo $?
```

Attendu : `0`, les cinq contrôles verts, l'assistant refermé (303).

## 3. Deux Workers, deux origines, deux bases, six buckets

```sh
{
  echo "canari  $(curl -s -o /dev/null -w '%{http_code}' "$CANARI/")  $(curl -s "$CANARI/" | grep -o '<title>[^<]*' | head -1)"
  echo "pilote  $(ac -o /dev/null -w '%{http_code}' "$PILOTE/")  $(ac "$PILOTE/" | grep -o '<title>[^<]*' | head -1)"
  echo "pilote sans jeton  $(curl -s -o /dev/null -w '%{http_code}' "$PILOTE/")"
} | tee "$E/origines.txt"
npx wrangler d1 list --json | node -e 'for (const d of JSON.parse(require("fs").readFileSync(0, "utf8"))) if (d.name.includes("-certif-staging")) console.log(d.name, d.uuid)' | tee "$E/bases.txt"
npx wrangler r2 bucket list -J eu | grep -o 'minshop-[a-z-]*-certif-staging-[a-z]*' | sort | tee "$E/buckets.txt"
npx wrangler kv namespace list | node -e 'for (const n of JSON.parse(require("fs").readFileSync(0, "utf8"))) if (n.title.includes("-certif-staging")) console.log(n.title, n.id)' | tee "$E/kv.txt"
liaisons() {
  V=$(npx wrangler deployments status --name "$1" --json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).versions[0].version_id')
  npx wrangler versions view "$V" --name "$1" --json | node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(v.resources.bindings.filter((b) => b.type !== "secret_text"), null, 2))'
}
liaisons minshop-pilote-certif-staging > "$E/liaisons-pilote.json"
liaisons minshop-canari-certif-staging > "$E/liaisons-canari.json"
grep -A3 '"d1"\|"kv_namespace"' "$E"/liaisons-*.json
```

Attendu : la canari en 200 sous son nom, le pilote en 200 sous le sien avec le
jeton et en 302 sans ; deux bases, deux identifiants ; six buckets, trois par
boutique ; deux namespaces de sessions. Chaque Worker est lié à **sa** base
(l'identifiant de `bases.txt`) et à **son** namespace (celui de `kv.txt`), et
ses buckets portent son nom. Les limiteurs, eux, portent le même
`namespace_id` dans les deux Workers : c'est la section 5 qui dit s'ils
partagent leurs compteurs. Si `liaisons` ne lit pas la réponse de wrangler,
une capture de chaque Worker → Settings → Bindings la remplace.

## 4. Un produit de chaque côté

Dans l'administration de la **canari** (`$CANARI/admin`) → Produits →
**Nouveau produit** : « Croix de test canari », URL `croix-test-canari`, prix
1,00, stock 1, actif, et **une image** (n'importe quel PNG,
`test/fixtures/clients/pilot-fr/catalogue/photos/tee-coton.png` par exemple) →
**Créer le produit**. L'image remplit le bucket que la section 7 devra vider.

Dans celle du **pilote** (`$PILOTE/admin`, code Access puis mot de passe) →
**Nouveau produit** : « Croix de test pilote », URL `croix-test-pilote`, prix
1,00, stock 1, actif, sans image.

```sh
total() { node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).total'; }
{
  for s in croix-test-canari croix-test-pilote; do
    echo "canari /api/products/$s  $(curl -s -o /dev/null -w '%{http_code}' "$CANARI/api/products/$s")"
    echo "pilote /api/products/$s  $(ac -o /dev/null -w '%{http_code}' "$PILOTE/api/products/$s")"
  done
  echo "canari produits  $(curl -s "$CANARI/api/products?limit=100" | total)"
  echo "pilote produits  $(ac "$PILOTE/api/products?limit=100" | total)"
} | tee "$E/produits-croises.txt"
npx wrangler d1 execute minshop-canari-certif-staging-db --remote --json --command "SELECT slug FROM products" > "$E/canari-produits.json"
npx wrangler d1 execute minshop-pilote-certif-staging-db --remote --json --command "SELECT slug FROM products WHERE slug LIKE 'croix-test-%'" > "$E/pilote-produits.json"
```

Attendu : chaque croix en 200 chez elle et en 404 chez l'autre ; un produit
dans la canari, vingt et un dans le pilote. La base de la canari ne connaît
que `croix-test-canari`, celle du pilote que `croix-test-pilote`.

## 5. Les limiteurs : un compteur par boutique

Les deux Workers déclarent les mêmes `namespace_id` de limiteurs, et
Cloudflare partage les compteurs de deux Workers d'un compte qui en déclarent
un identique. La clé de chaque compteur porte le nom d'hôte de la boutique :
un client bloqué sur l'une ne doit pas l'être sur l'autre.

```sh
seq 600 | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' "$CANARI/search?q=croix{}" | sort | uniq -c | tee "$E/limiteurs.txt"
echo "canari juste après  $(curl -s -o /dev/null -w '%{http_code}' "$CANARI/search?q=croix")" | tee -a "$E/limiteurs.txt"
echo "pilote juste après  $(ac -o /dev/null -w '%{http_code}' "$PILOTE/search?q=tee")" | tee -a "$E/limiteurs.txt"
echo "canari encore       $(curl -s -o /dev/null -w '%{http_code}' "$CANARI/search?q=croix")" | tee -a "$E/limiteurs.txt"
```

Attendu : des `429` parmi les 600 recherches de la canari (à l'étape 5, le
premier arrivait avant la 250e), puis `429` sur la canari, `200` sur le
pilote, et de nouveau `429` sur la canari : le pilote répond pendant que la
canari refuse. Si la canari répond déjà `200` juste après, sa fenêtre s'est
rouverte et la ligne ne tranche pas : le noter dans le README des preuves,
sans relancer plus fort. Sans aucun `429` côté canari, elle ne prouve rien.

Au passage réel, la canari était relue après le pilote seulement : 40 `429`
sur 600, le pilote en `200`, puis la canari en `200`. Rien ne disait qu'elle
refusait encore quand le pilote a répondu ; d'où l'ordre ci-dessus.

## 6. L'import croisé

Depuis l'arbre du **pilote**, avec la configuration de la canari : ce qu'un
fichier copié d'un dépôt à l'autre produirait.

```sh
cd "$P"
cp "$C/wrangler.jsonc" wrangler.jsonc
grep -c 'minshop-canari-certif-staging' wrangler.jsonc               # plusieurs lignes
npm run -s shopctl -- catalog import test/fixtures/clients/pilot-fr/catalogue/catalog.csv --remote --env staging --create-categories --json > "$E/import-croise.json"; echo $?
git restore wrangler.jsonc
npx wrangler d1 execute minshop-canari-certif-staging-db --remote --json --command "SELECT COUNT(*) AS n FROM products" > "$E/canari-apres-import.json"
cd "$C"
```

Attendu : `4`, « wrangler.jsonc ne nomme pas
« minshop-pilote-certif-staging-images » : il décrit une autre boutique que ce
manifeste », et toujours un seul produit dans la canari. Le refus tombe avant
toute lecture du compte. Le pilote, en `v0.3.9`, conseille encore
`prepare-client.mjs` ; c'est le conseil que `v0.3.10` corrige, pas le refus.

## 7. Supprimer la canari

D'abord une archive dans son bucket de sauvegardes, pour constater le refus
que le plan attend :

```sh
npm run shopctl -- backup keygen                     # ne remplace jamais une clé existante
npm run -s shopctl -- backup --env staging --upload --json | node -e 'const r = JSON.parse(require("fs").readFileSync(0, "utf8")); delete r.path; console.log(JSON.stringify(r, null, 2))' > "$E/backup.json"; echo $?
ID=$(node -p 'require(process.argv[1]).id' "$E/backup.json")
npm run -s shopctl -- destroy --env staging --dry-run --json > "$E/destroy-simulation.json"; echo $?
npm run -s shopctl -- destroy --env staging --confirm canari-certif --json > "$E/destroy-1.json"; echo $?
```

Attendu : la simulation liste six ressources, Worker, namespace des sessions,
trois buckets, base. Le premier passage sort en `6` : le Worker, le namespace
et le bucket de fichiers partent ; R2 refuse le bucket d'images (la croix) et
celui des sauvegardes (l'archive) ; la base reste. C'est le comportement
attendu. L'archive est déjà sur ce poste (`backups/$ID`) : rien à rapatrier.

Vider les deux buckets, avec la commande que `destroy` vient d'imprimer :

```sh
npx wrangler d1 execute minshop-canari-certif-staging-db --remote --json --command "SELECT image_key FROM media" | node -e 'for (const r of JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results) console.log(r.image_key)' > cles-images.txt
cat cles-images.txt                                  # media/….png, une ligne
while read -r k; do npx wrangler r2 object delete "minshop-canari-certif-staging-images/$k" --remote -J eu; done < cles-images.txt
(cd "backups/$ID" && find . -type f | sed 's|^\./||') | while read -r f; do npx wrangler r2 object delete "minshop-canari-certif-staging-backups/$ID/$f" --remote -J eu; done
rm cles-images.txt
npm run -s shopctl -- destroy --env staging --confirm canari-certif --json > "$E/destroy-2.json"; echo $?
```

Attendu : `0`, `removed` = les deux buckets puis la base. Si R2 refuse encore
un bucket, un objet n'était pas dans la liste : le tableau de bord (R2 → le
bucket → tout sélectionner → Supprimer) le vide, puis la même commande.

Ce qui reste du pilote, et ce qui ne reste pas de la canari :

```sh
npx wrangler d1 list --json | node -e 'for (const d of JSON.parse(require("fs").readFileSync(0, "utf8"))) if (d.name.includes("-certif-staging")) console.log(d.name, d.uuid)' | tee "$E/bases-apres.txt"
npx wrangler r2 bucket list -J eu | grep -o 'minshop-[a-z-]*-certif-staging-[a-z]*' | sort | tee "$E/buckets-apres.txt"
npx wrangler kv namespace list | node -e 'for (const n of JSON.parse(require("fs").readFileSync(0, "utf8"))) if (n.title.includes("-certif-staging")) console.log(n.title, n.id)' | tee "$E/kv-apres.txt"
liaisons minshop-pilote-certif-staging > "$E/liaisons-pilote-apres.json"
diff "$E/liaisons-pilote.json" "$E/liaisons-pilote-apres.json" && echo "liaisons du pilote inchangées"
{
  echo "canari  $(curl -s -o /dev/null -w '%{http_code}' "$CANARI/")"
  echo "pilote  $(ac -o /dev/null -w '%{http_code}' "$PILOTE/")  produits $(ac "$PILOTE/api/products?limit=100" | total)"
} | tee "$E/origines-apres.txt"
```

Attendu : une base, trois buckets et un namespace, tous du pilote, sous les
mêmes identifiants qu'à la section 3 ; la canari en 404, le pilote en 200 avec
ses vingt et un produits. Une canari sans réponse (`000`), comme au passage
réel depuis un second terminal, se relit en IPv4 : `curl -s -4 "$CANARI/"`
répond `error code: 1042`, plus de Worker sous ce nom. Puis, dans l'administration du pilote : Produits →
« Croix de test pilote » → **Supprimer**.

L'archive locale de la canari peut partir avec elle : `rm -rf "backups/$ID"`.

## 8. Les preuves

Le sous-domaine workers.dev du compte A figure dans plusieurs rapports ; le
dépôt est public. Le masquer avant le commit :

```sh
SUB=$(node -p 'new URL(process.argv[1]).hostname.split(".").at(-3)' "$CANARI")
grep -rl "$SUB" "$E" | xargs -r sed -i "s/$SUB/<sous-domaine>/g"
grep -rc "$SUB" "$E" | grep -v ':0$'                 # rien
git restore wrangler.jsonc
git switch -c certification-etape-7
git add client/certification && git commit -m "Certification, étape 7 : isolation de deux boutiques déployées"
git push -u origin certification-etape-7
gh pr create --fill
```

Dans `client/certification/etape-7/README.md`, ce qui ne laisse pas de
fichier : la capture des liaisons si `liaisons` a échoué, et tout ce qui a
accroché.

Enfin, Zero Trust → Access → Service credentials → « pilote-certif étape 7 »
→ **révoquer**, et `unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET CLOUDFLARE_ACCOUNT_ID`.

## Ce qui coche le plan

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| deux Workers sur deux origines, deux bases, six buckets | `origines.txt`, `bases.txt`, `buckets.txt`, `kv.txt`, `liaisons-*.json` | deux 200 sous deux noms ; deux identifiants de base, chacun lié à son seul Worker ; six buckets ; deux namespaces |
| un produit créé dans l'une n'apparaît pas dans l'autre | `produits-croises.txt`, `canari-produits.json`, `pilote-produits.json` | 200 chez soi, 404 chez l'autre, dans les deux sens |
| `catalog import` de l'une vers l'autre : refus | `import-croise.json`, `canari-apres-import.json` | code 4, « décrit une autre boutique » ; la canari inchangée |
| `destroy` : tout part, rien du pilote ; le refus de R2 constaté | `destroy-simulation.json`, `destroy-1.json`, `destroy-2.json`, `*-apres.*` | six ressources ; refus des deux buckets non vides et base gardée, puis tout parti ; le pilote inchangé |

Et, au-delà des quatre lignes : `deploy-canari-1.json` (le premier déploiement
d'une boutique sans Access, vert avec avertissements), `limiteurs.txt` (un
compteur par boutique malgré un `namespace_id` partagé).

## Ce qui ferme l'étape

La pull request des preuves de la canari verte. La donner dans le thread : les
rapports se relisent de là, puis le plan est coché.
