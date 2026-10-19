# Étape 5 — Sécurité sur la boutique déployée : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 5 du
[plan](plan.md#étape-5--sécurité-sur-la-boutique-déployée) et se passe sur
`pilote-certif` **montée en `v0.3.4`** (section 1) : les outils de cette
étape arrivent avec cette version, et c'est elle que la production de
l'étape 9 portera.

Elle a été répétée le 2026-10-14 dans un conteneur, contre le Worker construit
de `pilote-certif` (`v0.3.3`, son propre arbre, configuration de staging),
derrière une doublure d'Access (jeton de service, assertion signée, contournement
du webhook) et avec Stripe et Resend simulés : la porte distante, limiteurs
compris ; l'étape 4 rejouée sous une capture au format de `wrangler tail` ;
`npm audit` à la racine et dans `mcp/` ; le scan de secrets sur l'arbre, sur tout
l'historique public (pull requests comprises) et sur le build de staging. La
boutique a tenu. La répétition a trouvé deux défauts, et quatre trous dans
l'outillage de l'étape, corrigés dans le socle et livrés avec `v0.3.4`.

## Ce que la répétition a trouvé

1. **L'adresse de connexion à Cloudflare est publiée.** Cloudflare nomme un
   compte « <adresse>'s Account », et `shopctl` recopiait ce nom tel quel :
   dans ses rapports `--json`, sur la sortie de `backup`, `deploy` et
   `monitor`, dans l'en-tête des archives. Les cinq rapports `provision-*.json`
   et `deploy*.json` de l'étape 3 la portent, comme les journaux et les
   artefacts de chaque `Nightly` depuis le 2026-10-13, dans un dépôt public. Ce
   n'est pas l'adresse des commits : c'est l'identifiant du compte qui tient
   la boutique. `v0.3.4` la remplace par `<email>` à la source ; la section 8
   traite ce qui est déjà publié.
2. **Deux alertes élevées de `npm audit`**, dans `sharp` 0.35.2, que tire
   `miniflare` 4 : un outil de test, absent du Worker. L'audit de production du
   `Nightly` (`--omit=dev`) ne pouvait pas les voir. `v0.3.4` force `sharp`
   0.35.5 ; l'audit complet est vide.
3. **Ce que l'outillage ne savait pas encore faire**, ajouté en `v0.3.4` :
   - la porte distante poste des événements non signés et mal signés sur les
     deux webhooks, **sans** le jeton d'Access (Stripe n'en a pas) : le Worker
     doit répondre lui-même, et refuser ;
   - elle vérifie qu'aucune page, du catalogue à l'achat express, ne porte un
     champ de carte ;
   - `--limiteurs` déclenche les trois limiteurs (recherche, checkout,
     connexion) et attend un 429 qui dit quand revenir ;
   - `npm run test:logs:remote` relit une capture de `wrangler tail` sans jamais
     recopier ce qu'il trouve, et `npm run check:secrets:history` relit tout
     l'historique Git, pas seulement l'arbre.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé ou modifié |
|---|---|
| Staging `pilote-certif` (A) | le Worker en `v0.3.4` et la migration 0043 ; une commande de test (E) et son stock ; un média téléversé puis supprimé ; des rafales de recherches, de checkouts vides et de connexions (les limiteurs) |
| Access (A) | un jeton de service « pilote-certif étape 5 », révoqué à la fin |
| Stripe, mode test | un paiement, un remboursement partiel |
| Resend | trois ou quatre e-mails vers votre adresse de test |
| GitHub `shop-pilote-certif` | la pull request de montée `socle/v0.3.4` ; un run `Nightly` ; les journaux et artefacts des runs `Nightly` précédents supprimés (section 8) ; une pull request de preuves, qui masque aussi cinq preuves de l'étape 3 |
| Cloudflare (Workers, R2, D1, DNS) au-delà, compte B, `canari-certif`, Stripe live | rien |

La capture de `wrangler tail` contient l'adresse que vous taperez au paiement :
elle reste **hors du dépôt** (`~/certif-tail.json`) et s'efface section 7.
Seul le relevé, qui ne la recopie pas, va dans les preuves.

## 0. Shell propre

```sh
cd <chemin>/shop-pilote-certif
git switch main && git pull && git status --short     # rien
nvm use 22 && npm ci && npm ci --prefix mcp
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
export PREVIEW=$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)
export BASE_URL="https://$PREVIEW"
echo "$CLOUDFLARE_ACCOUNT_ID $BASE_URL"              # A et la preview
```

Le jeton de service du `Nightly` n'est lisible que par GitHub. Zero Trust
(compte A) → Access → Service credentials → **Créer un jeton de service**
« pilote-certif étape 5 », la durée la plus courte proposée. Puis, sur
l'application de **preview**, l'ajouter à la politique **Service Auth** à côté
de celui du `Nightly`.

```sh
read -rs CF_ACCESS_CLIENT_ID && export CF_ACCESS_CLIENT_ID          # coller, Entrée : rien à l'écran
read -rs CF_ACCESS_CLIENT_SECRET && export CF_ACCESS_CLIENT_SECRET
ac() { curl -s -H "cf-access-client-id: $CF_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $CF_ACCESS_CLIENT_SECRET" "$@"; }
ac -o /dev/null -w '%{http_code}\n' "$BASE_URL/"                         # 200
curl -s -o /dev/null -w '%{http_code}\n' "$BASE_URL/"                    # 302, vers Access
```

## 1. Monter en `v0.3.4`

Prérequis : le tag `v0.3.4`, publié par le workflow `Release` du socle.

```sh
npm run shopctl -- core status                       # v0.3.3
npm run shopctl -- core upgrade --to v0.3.4 --open-pr
gh pr checks socle/v0.3.4 --watch
gh pr merge socle/v0.3.4 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
mkdir -p client/certification/etape-5
npm run -s shopctl -- deploy --env staging --json > client/certification/etape-5/deploy-v0.3.4.json; echo $?
node -e 'const r = require("./client/certification/etape-5/deploy-v0.3.4.json"); console.log(r.ok, r.account, r.smoke.ok)'
```

En `v0.3.4`, le `npm run verify` que lance `deploy` dépend de deux réglages du
poste : avec `CLOUDFLARE_ACCOUNT_ID` exporté (section 0) ou `core.autocrlf=true`
dans `~/.gitconfig`, un test échoue et `deploy` s'arrête avant de téléverser
(code 5). Corrigé après `v0.3.4`. D'ici là, le déploiement se lance ainsi, et
`shopctl` épingle quand même le compte A depuis le manifeste :

```sh
env -u CLOUDFLARE_ACCOUNT_ID GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.autocrlf GIT_CONFIG_VALUE_0=false \
  npm run -s shopctl -- deploy --env staging --json > client/certification/etape-5/deploy-v0.3.4.json; echo $?
```

Attendu : la pull request verte ; `0` ; `true`, le compte A sous le nom
`<email>'s Account`, `true`. Le déploiement applique la migration 0043 (les
identifiants publics des pages légales, déjà remplis à la main à l'étape 4 :
elle ne touche rien). Rien à faire dans l'administration :
`docs/migrations/v0.3.4.md` le dit. Cette montée coche d'avance la ligne
« montée de version réelle » de l'étape 8.

Les mêmes notes demandent une chose côté GitHub : une boutique dont le
`Nightly` lit encore `NIGHTLY_EMAIL_TO` en **variable** la pose en secret,
sans quoi le `Nightly` de la section 8 l'écrit en clair. Sans l'afficher :

```sh
R=DamienGR/shop-pilote-certif
gh variable get NIGHTLY_EMAIL_TO --env staging --repo $R | tr -d '\r\n' | gh secret set NIGHTLY_EMAIL_TO --env staging --repo $R
gh variable delete NIGHTLY_EMAIL_TO --env staging --repo $R
```

## 2. Secrets : l'arbre, l'historique, le build

```sh
npm run check:secrets
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'
npm run check:secrets:history
npm run check:secrets:artifacts
```

Attendu : trois `✓`. Le deuxième compte les blobs, les commits et les refs
qu'il a relus : les têtes de pull request comprises, et l'historique du socle,
que chaque boutique porte depuis `shopctl new`. Le troisième relit `dist/`,
c'est-à-dire le build que la section 1 vient de téléverser. Une ligne rouge
donne un fichier et un blob, jamais la valeur : la remonter dans le thread.

## 3. Dépendances

```sh
npm audit --audit-level=high --json > client/certification/etape-5/audit-racine.json; echo $?
npm audit --prefix mcp --audit-level=high --json > client/certification/etape-5/audit-mcp.json; echo $?
node -e 'for (const f of ["racine", "mcp"]) console.log(f, require(`./client/certification/etape-5/audit-${f}.json`).metadata.vulnerabilities)'
```

Attendu : `0` deux fois, puis `high: 0, critical: 0` des deux côtés. L'audit
complet, outils de développement compris : celui du `Nightly` n'en voit que la
production.

## 4. Les limiteurs, puis la capture des journaux

Les limiteurs d'abord, **hors de la capture** : leurs rafales la saturent, et
wrangler l'échantillonne alors (`overload`), ce qui la rend inutilisable pour la
section 7. Dans le premier terminal :

```sh
npm run -s test:security:remote -- --limiteurs > client/certification/etape-5/porte-distante-limiteurs.txt; echo $?
```

En `v0.3.4`, attendu `1` : les trois contrôles de « Les limiteurs de débit » en
échec, tout le reste `✓`. Le limiteur de Cloudflare est actif mais permissif,
compté par localisation et mis en cache par machine : passé le 2026-10-15, il
n'a refusé aucune des 232 recherches envoyées une par une en 70 s, et son
premier 429 n'est venu qu'après environ 450 recherches envoyées 50 à la fois. Le
compteur exact des échecs de connexion et la porte recalibrée arrivent avec
`v0.3.5`.

Puis la capture, dans un **second terminal**, ouvert dans la boutique, qui
reste ouvert pendant les sections 5 et 6 :

```sh
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
npx wrangler tail minshop-pilote-certif-staging --format json > ~/certif-tail.json
```

Elle capture ce que la plateforme garde de chaque requête : l'URL, les
en-têtes, ce que la boutique écrit et ses exceptions, et le cron toutes les
cinq minutes. Workers Logs, activé dans la configuration de la boutique,
conserve les mêmes événements.

## 5. La porte distante

Dans le premier terminal, la capture tournant :

```sh
npm run -s test:security:remote > client/certification/etape-5/porte-distante.txt; echo $?
cat client/certification/etape-5/porte-distante.txt
```

Attendu : `0`, chaque contrôle `✓`, dont les sections « Les webhooks de
paiement » et « Aucune donnée de carte ». L'administration de staging a un mot
de passe : en Access seul, la porte échouerait, parce qu'un jeton de service y
entrerait. Elle envoie exprès une requête qui fait échouer le Worker (un
`POST /api/cart` au corps `application/octet-stream`), et une URL de commande
au jeton inventé, que la section 7 cherchera dans la capture.

## 6. Un achat sous la capture

Dans le navigateur, sur la preview :

1. **Commande E** : Baume à lèvres calendula, Colissimo, carte
   `4242 4242 4242 4242`. Sur la page de Stripe : nom **Jeanne Testeuse**,
   adresse **12 rue des Lilas, 35000 Rennes**, e-mail votre adresse de test.
   Attendu : la confirmation, les deux e-mails.
2. Stripe → Paiements → E → Rembourser **2,00 €**. Attendu : l'e-mail de
   remboursement.
3. Admin → Orders → E → Colissimo, suivi `6A00000000001` (fictif) → **Mark as
   fulfilled**. Attendu : l'e-mail d'expédition.
4. Admin → Settings → Email → **Send test** (vers votre adresse de test).
5. Admin → Media, trois fichiers :

   ```sh
   printf 'pas une image' > ~/faux.png
   { printf '\x89PNG\r\n\x1a\n'; head -c 6000000 /dev/zero; } > ~/gros.png
   ```

   Le sélecteur de fichiers de Windows atteint le dossier personnel de WSL
   par `\\wsl.localhost\Ubuntu\home\<utilisateur>`.

   `faux.png` : refusé, « Image must be JPEG, PNG, WebP, or GIF. » ; `gros.png` :
   refusé, « Image must be 5 MB or smaller. » ; une vraie photo de moins de
   5 Mo : acceptée, puis **supprimée** (elle n'est utilisée nulle part). Le
   contournement par un type déclaré faux (`-F 'files=@x.svg;type=image/png'`)
   est tenu par la porte de sécurité locale à chaque commit, sur le même code.
6. Une image du catalogue est servie pour ce qu'elle est :

   ```sh
   IMG=$(ac "$BASE_URL/api/products?limit=100" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).products.find((p) => p.image.includes("/images/")).image)')
   ac -I "$IMG" | grep -iE '^(HTTP|content-type|x-content-type-options)'
   ```

   Attendu : `200`, un `content-type` d'image, `x-content-type-options: nosniff`.

Puis attendre qu'un cron passe (la capture affiche un événement `scheduled`,
au plus cinq minutes), et arrêter la capture (Ctrl-C).

## 7. Le relevé

```sh
export PII_NEEDLES='Jeanne Testeuse;12 rue des Lilas'
npm run -s test:logs:remote -- ~/certif-tail.json
npm run -s test:logs:remote -- ~/certif-tail.json --json > client/certification/etape-5/journaux.json; echo $?
rm ~/certif-tail.json ~/faux.png ~/gros.png; unset PII_NEEDLES
```

`PII_NEEDLES` passe par l'environnement, jamais en argument : c'est une
adresse, et l'historique du shell la garderait. Le relevé cherche aussi toute
adresse e-mail, tout jeton invité `otk_…`, tout secret par sa forme.

Attendu : `0`, et

- **ce que la boutique a écrit** : ni adresse, ni jeton, ni secret, ni
  « Jeanne Testeuse », ni la rue ;
- **les URL** : rien. Les jetons de `/order/<jeton>` (la confirmation de E, et
  celui de la porte) sont masqués par la plateforme, par leur forme
  (`features/ids/token.ts`). Un jeton en clair ici est un constat : Workers Logs
  le garderait plusieurs jours ;
- **les en-têtes et métadonnées**, rapportés sans être jugés.
  `cf-access-authenticated-user-email` et `cf-access-jwt-assertion`, posés par
  Access sur chaque requête de la preview, arrivent déjà `REDACTED` dans la
  capture ; ils disparaissent en production, qui n'a pas d'Access. Les valeurs
  hexadécimales de `cf.tlsExportedAuthenticator` sont des métadonnées TLS de la
  plateforme.

Si le relevé signale un échantillonnage (`overload`), refaire les sections 4 à
7 : des événements manquent.

Puis, dans le tableau de bord du compte A → Workers & Pages →
`minshop-pilote-certif-staging` → **Observability** : l'événement du
`POST /api/webhook` qui a enregistré E, et sa trace. Le bon est celui de
l'heure de création de E (Admin → Orders) : un webhook antérieur peut être la
libération d'une réservation abandonnée (`UPDATE products SET stock = stock +
?`). Ni le nom ni l'adresse de Jeanne dans ses attributs : les traces sont
gardées comme les journaux, et la capture ne les montre pas.

## 8. Ce qui est déjà publié

Le `Nightly` d'après la montée, puis ses journaux et ses artefacts, relus pour
y chercher une adresse :

```sh
R=DamienGR/shop-pilote-certif
gh workflow run Nightly --repo $R && sleep 5
RUN=$(gh run list --workflow Nightly --repo $R --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch $RUN --repo $R
adresses() { grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$@" | sed -E 's/^(.)[^@]*@(.)[^.]*/\1…@\2…/' | sort | uniq -c; }
gh run view $RUN --repo $R --log > ~/certif-nightly.log; adresses ~/certif-nightly.log
gh run download $RUN --repo $R -D ~/certif-artefacts; adresses ~/certif-artefacts
rm -rf ~/certif-nightly.log ~/certif-artefacts
echo "$RUN" > client/certification/etape-5/nightly.txt
```

Attendu : aucune ligne sous chaque `adresses`. Une ligne y montre une adresse
masquée : la remonter dans le thread. La couleur du run n'est pas la question
ici ; le CPU p99 qu'il signale depuis l'étape 3 se tranche à l'étape 6.

Puis ce qui la porte encore :

- les cinq rapports de l'étape 3, masqués par un nouveau commit :

  ```sh
  sed -i.bak -E "s/\"name\": \"[^\"]*'s Account\"/\"name\": \"<email>'s Account\"/" client/certification/etape-3/*.json && rm client/certification/etape-3/*.json.bak
  git diff --stat                                    # cinq fichiers
  ```

  L'historique les garde : le récrire casserait chaque clone et chaque pull
  request du dépôt sans retirer l'adresse d'un clone déjà fait. On ne le fait
  pas ;
- les journaux et les artefacts des runs `Nightly` antérieurs à la montée ;
  les premiers portent aussi l'adresse de test, d'abord posée en variable.
  Les runs restent, avec leurs jobs verts ou rouges : l'étape 3 en cite un
  comme preuve. Un `Nightly` programmé qui a tourné après la montée est déjà
  propre : le relire comme `$RUN` et le retirer de la liste plutôt que d'effacer
  ses journaux. Un run cité comme preuve s'archive d'abord hors du dépôt, chez
  l'opérateur : les journaux de **chaque** tentative
  (`repos/$R/actions/runs/<id>/attempts/<n>/logs`) et chacun de ses artefacts,
  un run relancé en ayant un par tentative.

  ```sh
  gh run list --workflow Nightly --repo $R --limit 50 --json databaseId,createdAt -q ".[] | select(.databaseId != $RUN) | \"\(.databaseId) \(.createdAt)\"" > ~/certif-runs.txt
  gh api "repos/$R/actions/artifacts?per_page=100" -q ".artifacts[] | select((.name | startswith(\"nightly-\")) and .workflow_run.id != $RUN) | \"\(.id) \(.name)\"" > ~/certif-artefacts.txt
  cat ~/certif-runs.txt ~/certif-artefacts.txt       # relire : les runs qui perdent leurs journaux, les artefacts supprimés
  cut -d' ' -f1 ~/certif-runs.txt | xargs -I{} gh api -X DELETE repos/$R/actions/runs/{}/logs
  cut -d' ' -f1 ~/certif-artefacts.txt | xargs -I{} gh api -X DELETE repos/$R/actions/artifacts/{}
  rm ~/certif-runs.txt ~/certif-artefacts.txt
  ```

  Un run dont les journaux ont déjà expiré répond 404 : sans conséquence.

## 9. Les preuves

```sh
git restore wrangler.jsonc
git switch -c certification-etape-5
git add client/certification && git commit -m "Certification, étape 5 : sécurité du staging en v0.3.4"
git push -u origin certification-etape-5
gh pr create --fill
```

Dans `client/certification/etape-5/README.md`, ce qui ne laisse pas de fichier :
les deux refus et l'acceptation de la section 6.5 avec leurs messages, la
réponse de la section 6.6, ce que montrait la trace de la section 7, et le
`pi_…` de E.

Enfin, Zero Trust → Access → Service credentials → « pilote-certif étape 5 »
→ **révoquer**, et `unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET`.

## Après `v0.3.5` : fermer la ligne des limiteurs

`v0.3.5` compte les tentatives de connexion à l'administration exactement, dans
la base de la boutique (migration 0044) : cinq par réseau client et par quart
d'heure, la sixième refusée, le bon mot de passe compris. La recherche et le
checkout gardent le limiteur de Cloudflare, et la porte le mesure désormais à
ce qu'il garantit : un 429 sous une inondation, cinquante requêtes à la fois,
jusqu'à vingt fois la limite.

Prérequis : le tag `v0.3.5`. La section 0, avec un nouveau jeton de service le
temps du passage, puis :

```sh
npm run shopctl -- core upgrade --to v0.3.5 --open-pr
gh pr checks socle/v0.3.5 --watch
gh pr merge socle/v0.3.5 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run -s shopctl -- deploy --env staging --json > client/certification/etape-5/deploy-v0.3.5.json; echo $?
npm run -s test:security:remote -- --limiteurs > client/certification/etape-5/porte-distante-v0.3.5.txt; echo $?
```

Attendu : `0` deux fois, sans contournement pour `deploy` (les deux tests qui
dépendaient du poste ne le font plus). Le déploiement applique la migration
0044. Dans le relevé, les trois contrôles des limiteurs en `✓` : la recherche et
le checkout disent dans combien de requêtes leur premier 429 est venu ; la
connexion refuse au plus tard la sixième tentative, avec un `Retry-After` d'au
plus un quart d'heure. Pendant ce quart d'heure, le réseau qui a lancé la porte
ne peut plus envoyer de mot de passe à l'administration du staging : rien à
faire qu'attendre. Le compteur va par réseau, une adresse IPv4 ou un /64 IPv6,
et ne touche pas aux sessions ouvertes. Une session d'administration encore
valable entre donc sans rien demander, et un navigateur qui sort en IPv6 n'est
pas bloqué par une porte lancée depuis un terminal WSL, qui ne sort qu'en IPv4.
C'est ce qu'a vu le passage du 2026-10-15.

`deploy` a rendu `wrangler.jsonc` pour le staging : `git restore wrangler.jsonc`
avant la branche de preuves. Les deux fichiers dans une pull request de preuves,
le jeton de service révoqué,
puis le lien dans le thread : le rapport de sécurité ferme sa ligne d'après elle.

## Ce que le rapport de sécurité dira

Le rapport s'écrit depuis la pull request des preuves, une ligne du §8.4 du
plan d'implémentation par preuve :

| Ligne du §8.4 | Preuve | Attendu |
|---|---|---|
| aucune vulnérabilité élevée ou critique non justifiée | `audit-racine.json`, `audit-mcp.json` | zéro, outils de développement compris |
| aucune clé dans Git, les logs ou les artefacts | sections 2, 7 et 8, `journaux.json` | trois scans verts ; aucun secret dans la capture ; ni clé ni adresse dans le `Nightly` |
| webhooks signés | `porte-distante.txt` ; l'étape 4 | les événements signés passent (étape 4), les autres sont refusés par le Worker à travers le contournement d'Access |
| routes admin protégées | `porte-distante.txt` | chaque route dérivée des fichiers refusée sans session ; assistant fermé ; assertion Access forgée ignorée |
| rate limits actifs | `porte-distante-limiteurs.txt` | un 429 avec `retry-after` sur la recherche, le checkout et la connexion — ouverte en `v0.3.4`, voir section 4 |
| uploads contrôlés | `README.md` (6.5, 6.6) ; porte locale | refus par le type et la taille ; servi avec son type et `nosniff` |
| CSP et en-têtes présents | `porte-distante.txt` | durcissement complet sur chaque classe de réponse ; `script-src`/`style-src` sous la dérogation du plan (§6) |
| aucune donnée de carte traitée | `porte-distante.txt` ; le schéma | aucun champ de carte sur les pages de la boutique ; le paiement se fait sur la page de Stripe ; aucune colonne de carte dans les 43 migrations |
| aucune PII inutile dans les logs | `journaux.json`, la trace | rien dans ce que la boutique écrit ni dans les URL ; l'identité d'Access, propre à la preview, nommée comme telle |

## Ce qui ferme l'étape

La pull request des preuves verte. La donner dans le thread : le rapport de
sécurité s'écrit d'après elle, puis le plan est coché.
