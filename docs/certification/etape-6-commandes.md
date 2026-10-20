# Étape 6 — Accessibilité, navigateurs, performance : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 6 du
[plan](plan.md#étape-6--accessibilité-navigateurs-performance) et se passe sur
`pilote-certif` **montée en `v0.3.8`** (section 1) : les corrections de cette
étape sont arrivées en `v0.3.6`, l'administration est en français depuis
`v0.3.7`, `v0.3.8` cesse de relire l'historique des commandes, et c'est elle
que la production de l'étape 9 portera.

Elle a été répétée le 2026-10-15 dans un conteneur, contre le Worker construit
de `pilote-certif` (son propre arbre, son thème, configuration de staging,
catalogue témoin importé par `shopctl catalog`), derrière une doublure
d'Access, avec Stripe et Resend simulés : la porte navigateur distante,
Lighthouse mobile sur les quatre pages du plan, le CPU de chaque route sous le
profileur de V8, à froid et à chaud, la charge et la dernière unité. La
boutique a tenu : aucune erreur sous la charge, une seule session sur la
dernière unité. La répétition a trouvé un défaut d'accessibilité, une vitrine
qui dépensait son CPU en appels à la base, et une supervision qui jugeait le
CPU sur le mauvais signal, corrigés dans `v0.3.6`.

## Ce que la répétition a trouvé

1. **Le panier garni n'atteignait pas le contraste AA.** Lighthouse donnait
   96 en accessibilité sur `/cart` : l'indication sous chaque moyen de
   paiement, à 70 % de la couleur du bouton, tombait à 4,18:1 sur atelier et
   3,74:1 sur studio. La porte navigateur ne pouvait pas le voir : elle passe
   axe sur un panier vide, où ces boutons n'existent pas. `v0.3.6` met
   l'indication en pleine couleur, et la porte passe désormais axe sur un
   panier garni et sur l'achat express.
2. **La vitrine dépensait son CPU en appels D1.** Chaque appel à la base coûte
   du CPU dans l'isolat ; une fiche produit en faisait sept, plus de la moitié
   de son CPU à chaud. `v0.3.6` les envoie en un seul lot. Mesuré sur le
   Worker construit (temps JS et GC sous le profileur de V8, sur la machine
   du conteneur : des ordres de grandeur, pas les chiffres de Cloudflare) :

   | Page, à chaud (médiane de 20) | `v0.3.5` | `v0.3.6` |
   |---|---|---|
   | accueil | 11,0 ms | 5,7 ms |
   | catégorie | 12,1 ms | 8,8 ms |
   | fiche produit simple | 16,3 ms | 8,0 ms |
   | fiche produit à variantes | 13,3 ms | 8,2 ms |
   | recherche | 11,2 ms | 9,1 ms |
   | panier | 6,2 ms | 6,2 ms |
   | administration (tableau de bord, produits, commandes, réglages) | 12 à 16 ms | 9 à 16 ms |
   | connexion à l'administration | 33 ms | 26 ms |

   À froid, la première requête d'une page charge son code : 20 à 60 ms selon
   la page, avant comme après. Aucune optimisation ne ramène ce chargement
   sous 10 ms (l'analyseur Markdown seul en prend 11 sur une fiche produit) ;
   la connexion, elle, hache le mot de passe exprès. C'est ce que tolère
   Cloudflare, un dépassement occasionnel par isolat, et ce que la section 6
   mesure sur le vrai staging.
3. **`shopctl monitor` jugeait le CPU sur son p99**, rouge chaque nuit depuis
   l'étape 3 sans qu'aucune requête ait été arrêtée : le p99 d'une petite
   boutique, ce sont ses démarrages à froid. `v0.3.6` juge les invocations
   arrêtées (erreur 1102) et relève le p99 sans le juger.
4. **Le test clavier du menu replié échouait sur un menu d'en-tête vide.** Il
   se saute désormais en le disant ; la section 2 remplit le menu pour qu'il
   tourne.
5. **Ce que l'outillage ne savait pas encore faire** :
   `npm run test:cpu:remote` relit une capture de `wrangler tail` route par
   route, sans jamais recopier une URL.

Rien d'autre : la porte distante était verte à part le menu, Lighthouse à 100
en performance, accessibilité et SEO sur l'accueil, la catégorie et la fiche
(LCP 0,9 à 1,2 s, CLS 0, TBT 0 ms), la charge sans erreur, la dernière unité
vendue une fois.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé ou modifié |
|---|---|
| Staging `pilote-certif` (A) | le Worker en `v0.3.8` et sa migration 0045 ; trois liens dans le menu d'en-tête ; quatre commandes de test, une par navigateur, et leur stock ; le stock d'un produit mis à 1, puis réservé par la dernière unité ; quinze minutes de charge |
| Access (A) | un jeton de service « pilote-certif étape 6 », révoqué à la fin |
| Stripe, mode test | quatre paiements ; une session de paiement ouverte par la dernière unité, qui expire seule |
| Resend | les e-mails de confirmation des quatre commandes, vers votre adresse de test |
| GitHub `shop-pilote-certif` | la pull request de montée `socle/v0.3.8` ; une pull request de preuves |
| Cloudflare au-delà, compte B, `canari-certif`, Stripe live | rien |

## 0. Shell propre

Comme à l'étape 5 :

```sh
cd <chemin>/shop-pilote-certif
git switch main && git pull && git status --short     # rien
git remote get-url core || git remote add core https://github.com/DamienGR/minshop-platform.git   # shopctl new le pose, un clone non
nvm use 22 && npm ci && npm ci --prefix mcp
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
export PREVIEW=$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)
export BASE_URL="https://$PREVIEW"
echo "$CLOUDFLARE_ACCOUNT_ID $BASE_URL"              # A et la preview
```

Zero Trust (compte A) → Access → Service credentials → **Créer un jeton de
service** « pilote-certif étape 6 », la durée la plus courte proposée, ajouté
à la politique **Service Auth** de l'application de preview.

```sh
read -rs CF_ACCESS_CLIENT_ID && export CF_ACCESS_CLIENT_ID          # coller, Entrée : rien à l'écran
read -rs CF_ACCESS_CLIENT_SECRET && export CF_ACCESS_CLIENT_SECRET
ac() { curl -s -H "cf-access-client-id: $CF_ACCESS_CLIENT_ID" -H "cf-access-client-secret: $CF_ACCESS_CLIENT_SECRET" "$@"; }
ac -o /dev/null -w '%{http_code}\n' "$BASE_URL/"                         # 200
npx playwright install --with-deps chromium                             # une fois par poste
```

## 1. Monter en `v0.3.8`

Prérequis : le tag `v0.3.8`, publié par le workflow `Release` du socle.

```sh
npm run shopctl -- core status                       # v0.3.5
npm run shopctl -- core upgrade --to v0.3.8 --open-pr
gh pr checks socle/v0.3.8 --watch
gh pr merge socle/v0.3.8 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
mkdir -p client/certification/etape-6
npm run -s shopctl -- deploy --env staging --json > client/certification/etape-6/deploy-v0.3.8.json; echo $?
```

Attendu : la pull request verte, avec les notes de `v0.3.6`, `v0.3.7` et
`v0.3.8`, puis `0`. Une seule migration, la 0045 (cinq index et une table
vide), que `deploy` applique ; rien à faire dans l'administration, qui passe
en français (`docs/migrations/v0.3.7.md`, `v0.3.8.md`). Derrière Access, le test
de fumée du déploiement s'arrête à Access : le Worker n'a encore servi
personne. **Enchaîner tout de suite la section 2**, avant toute visite : c'est
la mesure à froid.

## 2. À froid : la première visite de chaque page

Dans un **second terminal**, ouvert dans la boutique :

```sh
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
npx wrangler tail minshop-pilote-certif-staging --format json > ~/certif-froid.json
```

Puis, dans le navigateur, sur la preview, **une visite de chaque**, dans cet
ordre : l'accueil, une catégorie, une fiche produit simple, une fiche à
variantes, une recherche (`lin`), **Ajouter au panier**, le panier. Puis
`/admin` : la connexion, le tableau de bord, Produits, Commandes, Réglages,
Médias, Pages. Enfin Admin → **Navigation** → **En-tête** : y ajouter trois
liens (deux catégories et une page légale, par exemple), qui restent ; le test
clavier du menu replié en a besoin.

Arrêter la capture (Ctrl-C), puis, dans le premier terminal :

```sh
npm run -s test:cpu:remote -- ~/certif-froid.json > client/certification/etape-6/cpu-froid.txt; echo $?
cat client/certification/etape-6/cpu-froid.txt
```

Attendu : `0`, « aucune invocation arrêtée ». La colonne `1re` est le coût à
froid de chaque route : au-delà de 10 ms, c'est attendu et relevé, pas jugé.

`wrangler tail` peut perdre des événements sans le dire : le 2026-10-19, 37
sur 46 requêtes, sans échantillonnage annoncé ni cache devant le Worker. Une
route absente du relevé se lit dans Observability (ci-dessous), qui garde
toutes les invocations.

Si la commande répond `2` (« aucun événement ne porte son temps CPU »), le
flux de `wrangler tail` ne donne pas le CPU : le chercher dans le tableau de
bord du compte A → Workers & Pages → `minshop-pilote-certif-staging` →
**Observability**. Chaque invocation y porte son temps CPU et son temps total ;
le constructeur de requêtes donne le p99 du CPU groupé par chemin, sur la
fenêtre de la visite. Une capture d'écran du résultat, sans URL de commande
visible, remplace `cpu-froid.txt` dans les preuves. Le constater dans le
thread : le relevé devra lire ces données-là.

## 3. La porte navigateur

```sh
npm run -s test:browser:remote > client/certification/etape-6/porte-navigateur.txt 2>&1; echo $?
tail -5 client/certification/etape-6/porte-navigateur.txt
```

Attendu : `0`, 86 tests, au plus six sautés et chacun avec sa raison : la
signature du design deux fois (prise sur le jeu d'essai, pas sur une boutique
déployée), l'état « catalogue vide » deux fois (une boutique déployée n'a pas
de catégorie vide), et sur desktop le menu replié s'il ne se replie pas à
cette largeur. « menu d'en-tête vide » ne doit plus apparaître. Les tests
d'accessibilité passent axe (WCAG A et AA) sur chaque page, le panier garni et
l'achat express compris.

## 4. Lighthouse mobile

En ligne de commande, pour que chaque mesure parte d'un navigateur vide (le
panneau Lighthouse de Chrome efface aussi le cookie d'Access, et sans cet
effacement il mesure un cache chaud). Le jeton de service passe par un fichier,
jamais en argument ; ces quatre pages ne chargent rien d'un autre domaine, et
la dernière commande le vérifie dans chaque rapport.

```sh
export CHROME_PATH=$(node -e 'console.log(require("playwright-core").chromium.executablePath())')
umask 077
node -e 'console.log(JSON.stringify({ "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET }))' > ~/certif-lh-headers.json
PLAN=$(ac "$BASE_URL/sitemap.xml")
CAT=$(echo "$PLAN" | grep -o '/categories/[^<]*' | head -1)
PROD=$(ac "$BASE_URL/api/products?limit=100" | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")).products.find((x) => x.in_stock && !x.variant_label); console.log(p.slug, p.id)')
echo "$CAT $PROD"
# Sous WSL, Lighthouse crée ses profils Chrome dans le dossier courant, sous
# un nom Windows littéral (`C:\Users\…\lighthouse.XXXX`), cookies d'Access
# compris : il tourne donc depuis un dossier jetable, hors de la boutique.
PREUVES="$PWD/client/certification/etape-6"
lh() { (cd "$(mktemp -d)" && npx -y lighthouse@13.5.0 "$BASE_URL$1" --form-factor=mobile --only-categories=performance,accessibility,seo \
  --extra-headers "$2" --output=json --output=html --output-path="$PREUVES/lighthouse-$3" --quiet --chrome-flags=--headless=new); }
lh / ~/certif-lh-headers.json accueil
lh "$CAT" ~/certif-lh-headers.json categorie
lh "/products/${PROD% *}" ~/certif-lh-headers.json fiche
```

Le panier, garni d'un produit, par le cookie du panier :

```sh
PANIER=$(ac -o /dev/null -D - -X POST "$BASE_URL/api/cart" -H "origin: $BASE_URL" -H 'content-type: application/x-www-form-urlencoded' \
  --data "_action=add&product_id=${PROD#* }" | grep -i '^set-cookie' | sed 's/^[^:]*: //; s/;.*//' | paste -sd ';' -)
node -e 'const h = require(process.argv[1]); h.cookie = process.argv[2]; console.log(JSON.stringify(h))' ~/certif-lh-headers.json "$PANIER" > ~/certif-lh-panier.json
lh /cart ~/certif-lh-panier.json panier
rm ~/certif-lh-headers.json ~/certif-lh-panier.json
```

Lighthouse recopie `--extra-headers` dans chaque rapport, JSON et HTML : le
jeton de service et le cookie du panier y sont **en clair**. Les masquer avant
que les rapports n'approchent le dépôt, puis vérifier :

```sh
node -e '
const fs = require("fs");
for (const f of process.argv.slice(1)) {
  let t = fs.readFileSync(f, "utf8");
  for (const s of [process.env.CF_ACCESS_CLIENT_SECRET, process.env.CF_ACCESS_CLIENT_ID]) t = t.split(s).join("<masqué>");
  t = t.replace(/("cookie":\s*")[^"]*(")/g, "$1<masqué>$2").replace(/(\\"cookie\\":\s*\\")[^"\\]*(\\")/g, "$1<masqué>$2");
  fs.writeFileSync(f, t);
}' client/certification/etape-6/lighthouse-*
grep -lF "$CF_ACCESS_CLIENT_SECRET" client/certification/etape-6/* || echo propre
```

Attendu : `propre`. Depuis `v0.3.9`, `npm run check:secrets` refuse un rapport
qui porte encore le secret.

Le relevé, et la vérification qu'aucune requête n'est partie ailleurs :

```sh
for p in accueil categorie fiche panier; do node -e '
const r = require(`./client/certification/etape-6/lighthouse-${process.argv[1]}.report.json`), a = r.audits, c = r.categories;
const ailleurs = a["network-requests"].details.items.map((i) => new URL(i.url).host).filter((h) => h !== new URL(r.finalDisplayedUrl).host);
console.log(process.argv[1].padEnd(10), ["performance", "accessibility", "seo"].map((k) => Math.round(c[k].score * 100)).join(" / "),
  " LCP", a["largest-contentful-paint"].displayValue, " CLS", a["cumulative-layout-shift"].displayValue, " TBT", a["total-blocking-time"].displayValue,
  ailleurs.length ? ` ⚠ ${[...new Set(ailleurs)].join(", ")}` : "");' $p; done
```

Attendu : ≥ 90 partout, aucun `⚠`. Un `⚠` nomme un domaine qui a reçu le
jeton de service : le remonter dans le thread et révoquer le jeton tout de
suite. Derrière Access, le SEO plafonne à 92 : Lighthouse lit `/robots.txt`
sans les en-têtes, reçoit la page de connexion d'Access et la juge invalide ;
celui de la boutique l'est (`ac "$BASE_URL/robots.txt"`). Les photos du catalogue témoin sont petites ; un LCP mesuré sur elles
dit peu de ce que donneront les vraies photos d'un marchand.

**L'INP** ne se mesure qu'avec des interactions, ce que Lighthouse en mode
navigation ne fait pas. Dans Chrome desktop, sur la preview : F12 →
Performance → **Live metrics** (mesures en direct), émulation d'un mobile et
CPU ralenti 4×, puis ajouter au panier, ouvrir le menu, changer de variante,
aller au panier. Noter l'INP affiché dans le `README.md` des preuves.

## 5. Le parcours d'achat à la main

Quatre achats de bout en bout, un par navigateur : **Chrome** et **Firefox**
sur le poste, **Safari sur iPhone**, **Chrome sur Android**. Chaque appareil
passe par la connexion d'Access de la preview (code par e-mail).

Sur chacun : l'accueil, une catégorie, une fiche, une variante si le produit
en a, **Ajouter au panier**, le panier (changer une quantité), le checkout,
Colissimo, carte `4242 4242 4242 4242` sur la page de Stripe, la confirmation.
Puis, sur le téléphone, le menu replié, la recherche, et **Acheter
maintenant** sur une fiche jusqu'au choix du paiement, sans payer.

Attendu : la confirmation et l'e-mail à chaque fois, rien de cassé ou de
coupé à l'écran. Dans le `README.md` des preuves : le navigateur, sa version,
le numéro de commande ; et une capture d'écran de la confirmation sur chaque
téléphone.

## 6. À chaud : la charge sous la capture

Le second terminal reprend la capture :

```sh
npx wrangler tail minshop-pilote-certif-staging --format json > ~/certif-chaud.json
```

Le premier lance la charge, vingt acheteurs pendant quinze minutes :

```sh
npm run -s test:load:remote -- --json client/certification/etape-6/charge.json; echo $?
```

Attendu : `0`, « 0 erreur(s) (5xx ou requête perdue) ». Les réponses 429 de la
recherche sont comptées à part : toute la charge vient d'une seule adresse, la
recherche est cadencée à la moitié de son limiteur.

À la fin de la charge, arrêter la capture (Ctrl-C), puis :

```sh
npm run -s test:cpu:remote -- ~/certif-chaud.json > client/certification/etape-6/cpu-chaud.txt; echo $?
```

Le monitor lit l'API Analytics avec le jeton API de staging (étape 2, droit
« Account Analytics » en lecture), le temps de cette seule commande :

```sh
read -rs CLOUDFLARE_API_TOKEN                        # coller, Entrée : rien à l'écran
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npm run -s shopctl -- monitor --env staging --hours 1 --json > client/certification/etape-6/monitor.json; echo $?
unset CLOUDFLARE_API_TOKEN
node -e 'for (const c of require("./client/certification/etape-6/monitor.json").checks ?? []) console.log(c.ok ? "✓" : "✗", c.name, "—", c.detail)'
```

Attendu : `0` deux fois. Dans `cpu-chaud.txt`, les percentiles de chaque route
sous la charge, « aucune invocation arrêtée ». Dans le monitor : le taux
d'erreur, les quotas du plan gratuit (une heure de charge reste loin des
70 %), « invocations arrêtées (plan gratuit) » à 0, et le CPU p99 relevé.
Si la capture signale un échantillonnage (`overload`), les percentiles portent
sur un échantillon : le dire dans les preuves, la mesure reste valable.

## 7. La dernière unité

Admin → Produits → un produit simple de peu de valeur → Stock **1** →
**Enregistrer les modifications**.

```sh
npm run -s test:last-unit:remote -- --product <slug> > client/certification/etape-6/derniere-unite.txt; echo $?
cat client/certification/etape-6/derniere-unite.txt
```

Attendu : `0`, une session ouverte sur `checkout.stripe.com`, quatre `409`,
« stock après : 0 ». L'unité reste réservée jusqu'à l'expiration de la session
de Stripe (35 minutes), puis revient : ne pas payer la session. Remettre
ensuite le stock d'origine dans l'administration.

## 8. Les preuves

```sh
rm ~/certif-froid.json ~/certif-chaud.json
git restore wrangler.jsonc
git switch -c certification-etape-6
git add client/certification && git commit -m "Certification, étape 6 : accessibilité, navigateurs, performance en v0.3.8"
git push -u origin certification-etape-6
gh pr create --fill
```

Les captures de `wrangler tail` restent hors du dépôt : elles portent les URL
de commande et les en-têtes d'Access. Seuls les relevés, qui ne les
recopient pas, vont dans les preuves.

Dans `client/certification/etape-6/README.md`, ce qui ne laisse pas de
fichier : l'INP de la section 4 ; pour chaque navigateur de la section 5, sa
version, le numéro de commande et ce qui a accroché, s'il y a lieu ; les
captures d'écran des téléphones.

Enfin, Zero Trust → Access → Service credentials → « pilote-certif étape 6 »
→ **révoquer**, et `unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET`.

## Ce que le rapport de performance dira

Le rapport s'écrit depuis la pull request des preuves :

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| porte navigateur contre le staging (§8.5) | `porte-navigateur.txt` | verte ; axe A/AA sur chaque page, panier garni et achat express compris |
| parcours d'achat sur quatre navigateurs | `README.md` | quatre commandes, quatre e-mails, rien de cassé |
| Lighthouse mobile ≥ 90, LCP, CLS, INP relevés | `lighthouse-*.report.json`, `README.md` | ≥ 90 en performance, accessibilité et SEO sur les quatre pages ; aucune requête hors de la boutique |
| charge de quinze minutes, aucune erreur, consommation relevée | `charge.json`, `monitor.json` | 0 erreur ; quotas du plan gratuit loin du seuil ; aucune invocation arrêtée |
| CPU par page, à froid et à chaud | `cpu-froid.txt`, `cpu-chaud.txt` | le coût de chaque route ; aucune invocation arrêtée |
| cinq checkouts sur la dernière unité | `derniere-unite.txt` | une session, quatre refus, aucune survente |

Et il tranche le CPU : à chaud, la vitrine tient-elle sous 10 ms ? À froid,
combien au-delà ? Trois issues : rester au plan gratuit, sous la surveillance
des invocations arrêtées que fait désormais le monitor, avec une dérogation
écrite ; passer le compte au plan **Workers Paid** (30 s de CPU par requête,
plus de quota quotidien) ; ou activer le cache de Workers en production, que
la configuration désactive aujourd'hui sur toutes les boutiques, pour que les
pages publiques ne réveillent plus le Worker. C'est à Damien de choisir, sur
les chiffres de cette étape.

## Ce qui ferme l'étape

La pull request des preuves verte. La donner dans le thread : le rapport de
performance s'écrit d'après elle, puis le plan est coché.
