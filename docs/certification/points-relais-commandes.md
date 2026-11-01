# Points relais — la campagne : les commandes (ticket #123, lot 6)

Fiche de passage pour le poste de Damien. Elle mène le lot 6 du §13.3 du
[plan d'implémentation](../implementation-plan.md#133-les-points-relais-et-les-expéditions-par-boxtal) :
la campagne qui fait entrer les points relais et l'achat d'étiquettes chez
Boxtal dans le périmètre certifié
([ADR 0020](../architecture/decisions/0020-expeditions-par-boxtal.md),
[ADR 0021](../architecture/decisions/0021-boxtal-apres-le-bac-a-sable.md)).
Travail d'après le pilote : elle ne fait avancer aucun des jalons 0 à 10.

Deux parties, sur pilote-certif :

- **A. La répétition sur le bac à sable** (deux heures environ). Une staging
  temporaire sur le `workers.dev` du compte mutualisé, Boxtal en bac à sable,
  Stripe en mode test : une commande en relais et une à domicile, de la
  recherche des points jusqu'aux deux étiquettes, aux e-mails, aux fiches et à
  l'export ; Stripe Tax sur une session sans adresse de livraison ; puis la
  staging détruite.
- **B. La commande réelle**, qui **attend le feu vert de Damien**. En
  production, Boxtal en production et Stripe live : une vraie commande en
  relais, son étiquette achetée, le colis déposé chez Mondial Relay puis retiré
  au point, l'URL de suivi vérifiée. Une heure le premier jour, le dépôt, puis
  le retrait quelques jours plus tard.

Les lots 3 à 5 tiennent déjà en doublure, contre le Worker construit et le
corpus relevé dans le bac à sable (`test/fixtures/boxtal/`) :
`test/integration/boxtal-labels.mjs`, `checkout-phone.mjs`, `checkout-relay.mjs`.
Ce qu'aucun conteneur ne voit, et que la partie A vérifie : le bac à sable
interrogé par un Worker déployé, le cache de Cloudflare, la page de Stripe sans
collecte d'adresse, Stripe Tax sans adresse de livraison, les e-mails dans de
vraies messageries, le PDF de l'étiquette, le passage de `PENDING` à
`CONFIRMED` chez Boxtal, l'URL de suivi rendue, et la liste des points sur un
téléphone.

## Ce que la fiche crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare, compte mutualisé | une staging de pilote-certif sur `workers.dev` (base, buckets, Worker, espace KV des sessions), créée en A1, détruite en A9 ; la production redéployée en B1 ; dans sa base, le tarif relais, les clés Boxtal de production (entrées en B2, retirées en B8), une commande payée puis remboursée, deux clés Stripe entrées puis supprimées |
| Boxtal, bac à sable | deux ou trois envois fictifs ; rien n'est facturé |
| Boxtal, production | une application API v3, et une v1 si vous voulez le devis, créées en B0, supprimées en B8 ; un envoi Mondial Relay réel, prélevé à son prix |
| Stripe, mode test | une clé restreinte et un endpoint de webhook vers la staging, supprimés en A9 ; trois paiements de test ; Stripe Tax réglé en mode test |
| Stripe, mode live | une clé restreinte, créée en B3, supprimée en B6 ; l'endpoint de webhook de l'étape 10, gardé ; un paiement de 4,90 € et son remboursement ; ses frais, que le remboursement ne rend pas |
| Resend | une clé pour la staging, révoquée en A9 ; les e-mails des commandes, vers Gmail et Outlook |
| GitHub `shop-pilote-certif` | la pull request `socle/v0.3.35`, celle de l'interrupteur, deux pull requests de preuves |
| GitHub `minshop-fleet` | un run `Deploy` approuvé (B1) |
| Mondial Relay | un colis déposé dans un point, retiré dans un autre (ou le même) |

**Les fenêtres.**

- En partie A, la staging répond à quiconque connaît son adresse
  `workers.dev` : son administration est derrière le mot de passe d'A1, et
  Stripe n'y accepte qu'une clé de test (`MINSHOP_ENV`). Elle vit le temps de
  la répétition.
- En partie B, de B3 à B6, la production prend de vrais paiements pour tout
  son catalogue. La tenir courte (une demi-heure), et relever à la fin
  qu'aucune autre commande n'est arrivée.

## 0. Avant de commencer

Prérequis :

- [ ] le tag **`v0.3.35`** du socle, publié par le workflow `Release` ;
- [ ] le **sous-domaine `workers.dev`** du compte mutualisé (Workers & Pages,
  à droite de la vue d'ensemble) : s'il n'est pas choisi, le choisir, faute de
  quoi le déploiement de la staging n'a pas d'adresse ;
- [ ] le compte mutualisé a la place d'**un cron de plus** : en Workers Free,
  cinq crons par compte, un par environnement déployé ;
- [ ] dans le gestionnaire de mots de passe, les clés des deux applications du
  **bac à sable Boxtal** qui ont relevé le corpus : API v3 (achat, suivi,
  points) et API v1 (devis) ;
- [ ] **Stripe, mode test** : Paramètres → Taxes, l'adresse d'origine et un
  enregistrement pour la France (pour A7). Stripe Tax ne facture rien en mode
  test ;
- [ ] **Resend** : une clé restreinte « pilote-certif staging relais »,
  envoi seul, sur le domaine `certif-minshop.miijot.fr` ;
- [ ] deux messageries, comme à l'étape 10 : **Gmail** (l'acheteur),
  **Outlook.com** (les alertes de commande) ; un **téléphone** pour A3.

Toutes les commandes se lancent sous Node 22 (≥ 22.23.4), depuis le clone du
pilote. Les jetons s'exportent sans écho, jamais en argument.

```sh
P=<chemin>/shop-pilote-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
cd "$P" && nvm use 22
gh repo set-default DamienGR/shop-pilote-certif
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # jeton de déploiement du compte mutualisé
COMPTE=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
export PROD="https://$(awk '/^  productionDomain:/ {print $2}' client/client.yaml)"
R="$P/client/certification/points-relais" && mkdir -p "$R/bac-a-sable" "$R/reel"
J=$(mktemp -d)                                       # hors du dépôt : l'export CSV
# Lectures des bases. Jamais l'e-mail, l'adresse ni le nom de l'acheteur : les preuves vont dans un dépôt public.
qs() { CLOUDFLARE_ACCOUNT_ID=$COMPTE npx wrangler d1 execute minshop-pilote-certif-staging-db --remote --json --command "$1"; }
qp() { CLOUDFLARE_ACCOUNT_ID=$COMPTE npx wrangler d1 execute minshop-pilote-certif-production-db --remote --json --command "$1"; }
dernier() { node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0].public_id'; }
echo "$COMPTE $PROD"
```

`wrangler d1 execute` trouve une base par le `wrangler.jsonc` de l'arbre :
`qs` sert après A1, qui le rend pour la staging, et `qp` après B1, qui le rend
pour la production.

## 1. Le socle, et l'option construite (quinze minutes)

```sh
npm run shopctl -- core upgrade --to v0.3.35 --open-pr
gh pr checks socle/v0.3.35 --watch
gh pr merge socle/v0.3.35 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.35
git switch -c points-relais
```

Dans `src/store.config.ts`, fichier de la boutique, sous `features` (la clé
créée si elle manque) :

```ts
features: { relayPoints: true },
```

```sh
git diff --stat                                      # src/store.config.ts seul
git commit -am "Points relais : l'option construite (socle, ticket #123)"
git push -u origin points-relais && gh pr create --fill
gh pr checks points-relais --watch && gh pr merge points-relais --merge
git switch main && git pull
```

L'option se construit, elle ne s'allume pas par environnement : le gabarit de
`wrangler.jsonc` ne rend pas la variable `RELAY_POINTS`, réservée aux essais
locaux. La staging et la production portent donc le même build. En
production, l'acheteur ne voit rien tant qu'aucune clé Boxtal n'est au
coffre : sans elles, aucun tarif relais n'est proposé et la commande ne
demande pas le téléphone ; seul l'éditeur de Livraison offre le mode relais. La production n'est redéployée qu'en B1, sur le socle qui sort de
la répétition.

Attendu : la pull request du socle verte, avec les notes de `v0.3.35`
(migrations 0047 et 0048, document d'expédition en version 4) ; celle de
l'interrupteur verte, sans demande de `core-change` : `src/store.config.ts`
est à la boutique.

## A. La répétition sur le bac à sable

### A1. La staging temporaire (vingt minutes, dont la vérification)

Sans `cloudflare.stagingDomain` dans le manifeste, la staging garde
`workers.dev`, sans application Access : c'est voulu pour une staging de
quelques heures, dont le mot de passe est posé avant le premier déploiement.

```sh
npm run shopctl -- provision --env staging --dry-run
npm run shopctl -- provision --env staging
npm run shopctl -- admin password --env staging      # un mot de passe neuf, saisi deux fois sans écho
npm run shopctl -- deploy --env staging
```

Attendu :

- `provision` : le compte mutualisé nommé par `cloudflare.accountId`, la base
  `minshop-pilote-certif-staging-db` et ses buckets créés en juridiction `eu`,
  la base marquée pour `DamienGR/shop-pilote-certif`, les migrations ;
- `admin password` : le mot de passe écrit et relu ;
- `deploy` : `npm run verify` (une dizaine de minutes), le build, `AUTH_SECRET`
  et `SECRETS_KEK` générés et transmis par entrée standard, le Worker
  `minshop-pilote-certif-staging` déployé, son adresse
  `https://minshop-pilote-certif-staging.<sous-domaine>.workers.dev`, le test
  de fumée vert.

```sh
export STG=<l'adresse que deploy affiche>
curl -s -o /dev/null -w '%{http_code}\n' "$STG/"   # 200
qs "SELECT repository, slug FROM _minshop_owner" > "$R/bac-a-sable/marqueur.json"
```

### A2. Installer et régler la staging (vingt minutes)

`$STG/admin/login`, le mot de passe d'A1, puis l'assistant : nom « Certif
Minshop (répétition) », fuseau Europe/Paris. Ensuite :

- **Réglages → E-mail** : Resend, la clé « pilote-certif staging relais »,
  l'expéditeur `commandes@certif-minshop.miijot.fr`, un e-mail de test reçu,
  et l'adresse **Outlook** comme destinataire des alertes de commande.
- **Stripe, mode test** : Développeurs → Clés API → **Créer une clé
  restreinte** « pilote-certif staging relais » : Checkout Sessions en
  écriture, Shipping Rates en lecture, Refunds en écriture. Développeurs →
  Webhooks → **Ajouter une destination** : `$STG/api/webhook`, les cinq
  événements (`checkout.session.completed`,
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`), et son secret de signature.
- **Réglages → Paiements → Carte (Stripe)** : la clé `rk_test_…` et le
  secret, **Enregistrer**. Attendu : « En service — mode test : aucun paiement
  réel ».
- **Réglages → Étiquettes de transport (Boxtal)** : Environnement « Bac à
  sable », les deux clés de l'API v3, les deux clés de l'API v1, l'offre à
  domicile « Colissimo Domicile - sans signature » retenue, la nature du
  contenu « Livres », **Enregistrer**.
- La protection anti-robots reste coupée : une staging de deux heures n'a pas
  de robot à arrêter, et les clés de test de Cloudflare n'y prouveraient rien.

**Livraison** : dans la zone France, garder le tarif à domicile du socle
(Colissimo, 5,90 € si `store.config.ts` ne le change pas), puis **Ajouter un
tarif** : libellé « Point relais Mondial Relay », mode « Point relais
(Boxtal) », offre relais Mondial Relay C.pourToi®, prix forfaitaire 3,90 €,
**Enregistrer la livraison**. Attendu : « Configuration de livraison
enregistrée. », sans l'avis « Les clés Boxtal ne sont pas enregistrées ».

**Produits → Nouveau** : « Article de répétition », 10,00 €, stock 5,
**Actif**, **Nécessite une livraison**, poids 500 g, sans image.

```sh
qs "SELECT value FROM settings WHERE key = 'shipping_config'" > "$J/livraison.json"
node -p 'JSON.parse(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].results[0].value).schema' "$J/livraison.json" | tee "$R/bac-a-sable/livraison-schema.txt"
qs "SELECT key FROM settings WHERE key LIKE 'enc:boxtal_%' OR key = 'boxtal_environment'" > "$R/bac-a-sable/boxtal-reglages.json"
```

Attendu : le document d'expédition en version `4` ; au coffre, les quatre clés
`enc:boxtal_…`, et pas de `boxtal_environment` : absent, c'est le bac à sable.

### A3. Le téléphone et le choix du point (quinze minutes)

Dans une fenêtre privée : `$STG/products/article-de-repetition` → **Ajouter
au panier** → le panier, destination France → **Payer par carte**.

Attendu : **pas la page de Stripe**, mais `/checkout?method=stripe&country=FR`,
le formulaire d'adresse avec un champ « Téléphone » (« Le transporteur s'en
sert pour vous prévenir de la livraison. »).

Saisir l'adresse **Gmail**, « Répétition Relais », `12 place Léon-Blum`,
`75011`, `Paris`, `FR`, `06 12 34 56 78` (une adresse publique, la mairie du
11e, que le corpus a déjà cherchée), puis **Continuer vers la livraison**.
Noter combien de temps la page met : c'est la première recherche, faite chez
Boxtal.

Attendu : deux tarifs, Colissimo à 5,90 € et « Point relais Mondial Relay » à
3,90 €, avec « En point relais : vous le choisissez à l'étape suivante. ».
Le bouton dit **Continuer**, et non « Payer par carte » : sans JavaScript, il
ne peut pas suivre le tarif coché. Choisir le relais → **Continuer** :
« Livraison : Point relais Mondial Relay, 3,90 € », puis « Votre point
relais », « Les plus proches de … », dix points au plus, du plus proche au
plus loin, avec leur distance et leurs horaires. Une capture, `points.png`.

Deux contrôles sur cette liste, avant d'aller plus loin :

- **sans JavaScript** : outils de développement → « Disable JavaScript »,
  recharger. La liste reste un formulaire, un point se coche, et les deux
  boutons (« Payer par carte », « Changer de mode de livraison ») sont des
  boutons d'envoi. Ne pas payer ainsi ; rétablir JavaScript ;
- **sur le téléphone** : le même parcours jusqu'à la liste. Lisible, sans
  défilement horizontal, chaque point se touche sans viser. Une capture,
  `telephone-points.png`, puis abandonner sur le téléphone avant « Payer par
  carte ».

Sur l'ordinateur : cocher le **premier** point, noter son nom → **Payer par
carte**. Le point validé ouvre la session de Stripe : il n'y a pas d'écran
entre les deux.

### A4. La page de Stripe, et la commande en relais (quinze minutes)

Sur la page de Stripe, avant de payer :

- l'adresse commence par `https://checkout.stripe.com/c/pay/cs_test_`, le
  bandeau du mode test affiché ;
- l'e-mail prérempli ; **aucun champ d'adresse de livraison, aucun champ de
  téléphone** ;
- une seule livraison, « Point relais Mondial Relay » à 3,90 €, le total
  13,90 €.

Une capture, `stripe-sans-adresse.png`. Payer avec `4242 4242 4242 4242`, une
date future, un code quelconque. Attendu : la page de commande de la boutique,
« Votre point relais » et le point choisi.

```sh
O=$(qs "SELECT public_id FROM orders ORDER BY id DESC LIMIT 1" | dernier) && echo "$O"
qs "SELECT public_id, status, amount_total_cents, shipping_cents, shipping_label, delivery_method, payment_method, json_extract(relay_point, '$.offer') AS offre, json_extract(relay_point, '$.code') AS code, json_extract(relay_point, '$.name') AS point, json_extract(ship_address, '$.country') AS pays, json_extract(ship_address, '$.phone') IS NOT NULL AS telephone FROM orders WHERE public_id = '$O'" > "$R/bac-a-sable/commande-relais.json"
qs "SELECT relay_point IS NOT NULL AS point, ship_address IS NULL AS adresse_effacee FROM checkout_reservations WHERE public_id = '$O'" > "$R/bac-a-sable/reservation-relais.json"
qs "SELECT kind, state FROM order_notifications WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$R/bac-a-sable/notifications-relais.json"
```

| Où | Attendu |
|---|---|
| `commande-relais.json` | `paid`, 1390, 390, « Point relais Mondial Relay », `relay`, `stripe`, `MONR-CpourToi`, le code et le nom du point choisi, `FR`, 1 |
| `reservation-relais.json` | le point gardé, l'adresse effacée au règlement (1, 1) |
| `notifications-relais.json` | la confirmation et l'alerte `sent` |
| Gmail | la confirmation, avec « Votre point relais » : le nom, la rue, le code postal et la ville du point |
| Outlook | l'alerte, avec « Point relais choisi » et « Code du point : … » |
| Admin → Commandes → la commande | « Point relais », « Code …, offre MONR-CpourToi », et l'adresse de livraison |
| « Voir ma commande », depuis Gmail | « Votre point relais » |

Une capture de chaque e-mail dans `$R/bac-a-sable/emails/`, et de la fiche
commande (`fiche-relais.png`).

### A5. L'étiquette relais (quinze minutes, dont l'attente du suivi)

Admin → la commande → « Acheter une étiquette chez Boxtal ».

Attendu avant l'achat : « Bac à sable de Boxtal : l'étiquette est fictive et
rien n'est facturé. » ; « Au point relais …, code …, que l'acheteur a
choisi. » ; la ligne de l'offre relais, avec son prix hors taxes (le devis v1) ;
le destinataire prérempli, téléphone compris.

Expéditeur (enregistré pour la suite, dans la base de la staging seulement) :
« Certif Minshop », vos prénom et nom, votre e-mail, un téléphone, une adresse
d'expédition fictive en France. Colis : 30 × 20 × 10 cm, 0,6 kg. **Acheter
l'étiquette**, et noter l'heure.

Attendu : « Étiquette achetée chez Boxtal (…, envoi …). Le numéro de suivi
arrive quand Boxtal a confirmé l'envoi… ». Une vingtaine de secondes plus tard,
**Relire le suivi** : le numéro et son lien, la commande « Expédiée ».
Noter le délai entre l'achat et le numéro.

- **Étiquette (PDF)** : un PDF s'ouvre (A4 dans le bac à sable), qui nomme le
  point. Le garder : `etiquette-relais.pdf` ;
- Gmail : l'e-mail d'expédition, « À retirer au point relais » et le point, le
  numéro et son lien. Le lien mène à `mondialrelay.com/public/permanent/tracking.aspx?ens=…`.
  Noter ce que la page de Mondial Relay montre pour un numéro du bac à sable.

```sh
qs "SELECT status, vendor, rate_id AS offre, tracking_number IS NOT NULL AS suivi, amount_cents FROM shipping_labels WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$R/bac-a-sable/etiquette-relais.json"
qs "SELECT fulfillment_status, tracking_carrier, tracking_number, tracking_url FROM orders WHERE public_id = '$O'" > "$R/bac-a-sable/suivi-relais.json"
```

Attendu : `purchased`, `boxtal`, `MONR-CpourToi`, 1, un prix ; `fulfilled`,
`mondialrelay`, le numéro, l'URL avec `ens=`.

### A6. Une commande à domicile, et son étiquette (quinze minutes)

La même boutique, une seconde commande, à domicile cette fois : l'ADR 0020
demande une étiquette de chaque sorte.

Fenêtre privée → l'article → panier → **Payer par carte** → la même adresse →
**Colissimo** → **Continuer**, qui mène droit à Stripe. La zone a un tarif
relais : la carte passe encore par `/checkout`, et Stripe ne reçoit que le
tarif choisi. Attendu sur Stripe : aucun champ d'adresse, « Colissimo » à
5,90 €, le total 15,90 €. Payer avec `4242 4242 4242 4242`.

Admin → la commande → l'étiquette sur « Colissimo Domicile - sans signature »,
l'expéditeur prérempli, le même colis → **Acheter l'étiquette** → **Relire le
suivi**.

```sh
O2=$(qs "SELECT public_id FROM orders ORDER BY id DESC LIMIT 1" | dernier) && echo "$O2"
qs "SELECT status, amount_total_cents, shipping_label, delivery_method, relay_point IS NULL AS sans_point, fulfillment_status, tracking_carrier, tracking_url FROM orders WHERE public_id = '$O2'" > "$R/bac-a-sable/commande-domicile.json"
qs "SELECT status, vendor, rate_id AS offre FROM shipping_labels WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O2')" > "$R/bac-a-sable/etiquette-domicile.json"
```

Attendu : `paid`, 1590, « Colissimo », `shipping`, 1, `fulfilled`,
`colissimo`, une URL `laposte.fr/outils/suivre-vos-envois?code=…` ;
`purchased`, `boxtal`, `POFR-ColissimoAccess`. L'e-mail d'expédition sans
point relais.

### A7. Stripe Tax sur l'adresse de facturation (dix minutes)

Le pilote vend TTC ([ADR 0010](../architecture/decisions/0010-tva-facturation-et-consentement.md))
et n'allume pas Stripe Tax. Ce contrôle couvre la boutique qui l'allumerait :
sa session ne reçoit plus d'adresse de livraison, et Stripe Tax calcule alors
sur l'adresse de facturation (plan, §13.3, lot 4).

Réglages → **Taxes automatiques** : activer. Puis une troisième commande en
relais, comme en A3, jusqu'à la page de Stripe.

Attendu : Stripe demande l'adresse de facturation (au moins le pays et le
code postal), et une ligne de taxe paraît une fois l'adresse saisie. Payer
avec `4242 4242 4242 4242`.

```sh
O3=$(qs "SELECT public_id FROM orders ORDER BY id DESC LIMIT 1" | dernier) && echo "$O3"
qs "SELECT status, amount_total_cents, shipping_cents, tax_cents, delivery_method FROM orders WHERE public_id = '$O3'" > "$R/bac-a-sable/commande-taxe.json"
```

Attendu : `paid`, `tax_cents` égal à la taxe que Stripe a montrée, et
`amount_total_cents` égal au sous-total, plus la livraison, plus la taxe ;
`relay`. Puis Réglages → **Taxes automatiques** : désactiver.

Si Stripe refuse la session (une erreur au clic sur « Payer par carte »),
relever le message dans le README : c'est un défaut à corriger dans le socle
avant la partie B.

### A8. L'export, et une adresse sans point (dix minutes)

- Admin → Commandes → **Exporter en CSV** : ouvrir le fichier dans un
  tableur. Attendu : les colonnes `Delivery`, `Relay point code` et
  `Relay point` ; `relay`, le code et le point sur les commandes d'A4 et
  d'A7, `shipping` et rien d'autre sur celle d'A6. Une capture de ces seules colonnes et du numéro de commande,
  `export.png` ; le fichier reste hors du dépôt (`$J`), il porte les e-mails.
- Une adresse qu'aucun réseau ne sert : fenêtre privée → l'article → panier →
  **Payer par carte** → la même adresse, code postal `99999`, ville
  « Nulle-Part » → **Continuer vers la livraison**. Attendu : Colissimo seul,
  aucun message d'erreur ; la commande continuerait à domicile. Ne pas payer.
  Une capture, `sans-point.png`.

### A9. Détruire la staging (dix minutes)

```sh
npm run shopctl -- destroy --env staging --confirm pilote-certif --dry-run
npm run shopctl -- destroy --env staging --confirm pilote-certif
git restore wrangler.jsonc
```

Attendu : la simulation liste ce qu'elle supprimerait de la staging, et rien
de la production, la base en dernier ; puis tout est supprimé. Un bucket
qui refuse parce qu'il n'est pas vide se vide comme `destroy` le dit (aucune
image n'a été envoyée : il ne devrait pas y en avoir). La variable de dépôt
`STAGING_RETIRED`, posée à l'étape 9, reste : `destroy` la rappelle, il n'y a
rien à refaire.

Puis, à la main :

- [ ] Stripe, mode test : la clé « pilote-certif staging relais » et l'endpoint
  vers `workers.dev`, supprimés ; les réglages de Stripe Tax en mode test
  peuvent rester ;
- [ ] Resend : la clé « pilote-certif staging relais », révoquée ;
- [ ] Boxtal, bac à sable : rien. Les envois fictifs restent dans l'espace, et
  les clés servent encore aux relevés du corpus.

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$STG/"   # plus de Worker : 404
```

### A10. Les preuves de la répétition

```sh
grep -rl "$HOME" "$R" | xargs -r sed -i "s|$HOME|~|g"
grep -rc "$HOME" "$R" | grep -v ':0$'                # rien
grep -l '@' "$R"/bac-a-sable/*.json "$R"/bac-a-sable/*.txt   # rien : aucune adresse e-mail dans les lectures
git status --short                                   # client/certification seulement ; wrangler.jsonc intact
git switch -c points-relais-bac-a-sable
git add client/certification && git commit -m "Points relais : la répétition sur le bac à sable (ticket #123 du socle, lot 6)"
git push -u origin points-relais-bac-a-sable && gh pr create --fill
```

Dans `client/certification/points-relais/bac-a-sable/README.md`, ce qui ne
laisse pas de fichier : la durée de la première recherche et celle d'un
rechargement, le délai entre l'achat et le numéro de suivi (relais, domicile),
ce que la page de Mondial Relay montre pour un numéro du bac à sable, ce que
le téléphone et la page sans JavaScript ont montré, la taxe de Stripe en A7,
et tout ce qui a accroché.

**La pull request donnée dans le thread.** Ce que la répétition trouve se
corrige dans le socle (`v0.3.36`, si besoin) avant la partie B.

## B. La commande réelle

Elle touche de vrais comptes : un paiement réel, une étiquette réelle que
Boxtal prélève, un colis. **Elle attend le feu vert de Damien**, et un socle
qui a passé la partie A : `v0.3.35`, ou la version qui corrige ce qu'elle a
trouvé.

### B0. Ce qui doit exister

- [ ] **Boxtal en production** : le compte activé, l'IBAN et le mandat de
  prélèvement signés ; une application **API v3** de production (ses deux
  clés dans le gestionnaire de mots de passe) ; une application **API v1** de
  production, facultative, pour voir le prix avant l'achat. Les clés du bac à
  sable n'ouvrent pas la production (401) ;
- [ ] **le colis** : un livre de poche dans un carton ou une enveloppe
  matelassée, mesuré et pesé (moins d'un kilo) ;
- [ ] **le point de dépôt** : un point Mondial Relay qui accepte les dépôts,
  près de chez vous (C.pourToi® se dépose en point relais) ;
- [ ] **votre téléphone portable** : Mondial Relay y envoie l'avis de mise à
  disposition, et le code de retrait.

### B1. La production au socle de la répétition (quinze minutes)

Si la répétition a donné une `v0.3.36` : `npm run shopctl -- core upgrade
--to v0.3.36 --open-pr`, la pull request fusionnée, comme au §1.

```sh
git switch main && git pull && npm ci
npm run shopctl -- core status
gh workflow run deploy.yml -R DamienGR/minshop-fleet -f shop=pilote-certif -f environment=production
sleep 10 && D=$(gh run list -R DamienGR/minshop-fleet --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') && echo "$D"
```

GitHub → `minshop-fleet` → Actions → ce run → **Review deployments** →
`production` → **Approve and deploy**.

```sh
gh run watch "$D" -R DamienGR/minshop-fleet; echo $?
npm run -s shopctl -- provision --env production --json > "$R/reel/provision.json"; echo $?
qp "SELECT COUNT(*) AS commandes FROM orders" > "$R/reel/commandes-avant.json"
```

Attendu : le run vert, la sauvegarde préalable, les migrations 0047 et 0048,
le test de fumée vert ; `provision` à `0`, rien de créé, la configuration de
production rendue pour `qp`.

### B2. Boxtal en production, le tarif relais (dix minutes)

`$PROD/admin/settings` → **Étiquettes de transport (Boxtal)** : Environnement
« Production (étiquettes réelles, facturées) », les deux clés v3 de
production, les deux clés v1 si vous les avez, l'offre à domicile
« Colissimo Domicile - sans signature », la nature « Livres »,
**Enregistrer**. Dès cet instant, la commande demande le téléphone ; le panier
reste fermé tant que Stripe n'est pas au coffre.

**Livraison** → zone France → **Ajouter un tarif** : « Point relais Mondial
Relay », « Point relais (Boxtal) », Mondial Relay C.pourToi®, forfaitaire
3,90 €, **Enregistrer la livraison**.

```sh
qp "SELECT key FROM settings WHERE key LIKE 'enc:boxtal_%'" > "$R/reel/boxtal-cles.json"
qp "SELECT value FROM settings WHERE key = 'boxtal_environment'" > "$R/reel/boxtal-environnement.json"
```

Attendu : les clés v3 au coffre (et v1 si saisies) ; `live`.

### B3. Stripe live : la fenêtre s'ouvre (dix minutes)

Comme à l'étape 10, §2 et §3 ([fiche](etape-10-commandes.md)) : Stripe, mode
live → Développeurs → Clés API → **Créer une clé restreinte**
« pilote-certif production relais » (Checkout Sessions en écriture, Shipping
Rates en lecture, Refunds en écriture). L'endpoint de webhook de l'étape 10
est toujours là : révéler son secret.

Réglages → Paiements → Carte (Stripe) : la clé et le secret, **Enregistrer**.
Attendu : « En service — mode live : paiements réels ». **La fenêtre s'ouvre
ici** : noter l'heure.

Produits → « Article de certification » : **Actif**, stock 1,
**Enregistrer** (1,00 €, 50 g, expédié, comme à l'étape 10).

### B4. La commande réelle (quinze minutes)

Fenêtre privée : `$PROD/products/article-de-certification` → **Ajouter au
panier** → le panier → la case des conditions générales → **Payer par carte**.

Sur `/checkout` : votre adresse **Gmail**, votre nom, votre adresse, votre
**vrai téléphone portable** → **Continuer vers la livraison** → « Point relais
Mondial Relay » → **Continuer** → le point où vous retirerez le colis →
**Payer par carte**.

Sur la page de Stripe, avant de payer : `https://checkout.stripe.com/c/pay/cs_live_`,
aucun bandeau de test, aucun champ d'adresse ni de téléphone, « Point relais
Mondial Relay » à 3,90 €, le total 4,90 €. Payer avec une vraie carte,
valider l'authentification de la banque. Noter l'heure.

```sh
O=$(qp "SELECT public_id FROM orders ORDER BY id DESC LIMIT 1" | dernier) && echo "$O"
qp "SELECT public_id, status, amount_total_cents, shipping_cents, shipping_label, delivery_method, payment_method, substr(provider_session_id, 1, 8) AS session, substr(provider_payment_id, 1, 3) AS paiement, json_extract(relay_point, '$.offer') AS offre, json_extract(relay_point, '$.country') AS pays_point, json_extract(relay_point, '$.code') IS NOT NULL AS code_point, json_extract(ship_address, '$.phone') IS NOT NULL AS telephone FROM orders WHERE public_id = '$O'" > "$R/reel/commande.json"
qp "SELECT kind, state FROM order_notifications WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$R/reel/notifications.json"
```

Attendu : `paid`, 490, 390, « Point relais Mondial Relay », `relay`, `stripe`,
`cs_live_`, `pi_`, `MONR-CpourToi`, `FR`, 1, 1 ; la confirmation et l'alerte
`sent`. Le code du point et son adresse restent hors des preuves : ils disent
où vous habitez. Dans Gmail et Outlook, le point comme en A4 ; les captures
rognées (ni nom, ni adresse, ni point).

### B5. L'étiquette réelle (quinze minutes)

Admin → la commande → « Acheter une étiquette chez Boxtal ». Attendu : plus de
bandeau du bac à sable ; « Au point relais … que l'acheteur a choisi » ; avec
le devis v1, le prix hors taxes de l'offre.

Expéditeur : l'adresse d'où part le colis, avec votre téléphone (elle est
enregistrée dans les réglages de la production). Colis : ses mesures et son
poids réels. **Acheter l'étiquette**, noter l'heure, puis **Relire le suivi**
une vingtaine de secondes plus tard.

```sh
qp "SELECT status, vendor, rate_id AS offre, tracking_number IS NOT NULL AS suivi, amount_cents FROM shipping_labels WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$R/reel/etiquette.json"
qp "SELECT fulfillment_status, tracking_carrier, tracking_url LIKE 'https://www.mondialrelay.com/%' OR tracking_url LIKE 'https://mondialrelay.com/%' AS lien_mondial_relay FROM orders WHERE public_id = '$O'" > "$R/reel/suivi.json"
```

Attendu : `purchased`, `boxtal`, `MONR-CpourToi`, 1, le prix ; `fulfilled`,
`mondialrelay`, 1. Si le lien n'est pas sur `mondialrelay.com`, noter son hôte
dans le README : c'est un constat, pas un échec.

- **Étiquette (PDF)** : l'imprimer et la coller sur le colis. L'URL se
  resigne à chaque lecture (ADR 0021) : la relire plus tard marche aussi.
- Gmail : l'e-mail d'expédition, le point, le numéro et son lien. Ouvrir le
  lien : la page de Mondial Relay connaît le colis (« pris en charge » ou
  équivalent, avant tout dépôt).
- L'espace Boxtal, en production : l'envoi, son prix, son état.

### B6. Rembourser, et fermer la fenêtre (dix minutes)

Le remboursement d'abord, tant que la clé est au coffre, et seulement une
fois la commande « Expédiée » avec son numéro : une étiquette ne s'achète que
sur une commande payée, et un remboursement arrivé pendant l'achat laisserait
l'étiquette hors de la commande. Il n'annule pas l'envoi : la boutique ne lie
pas le remboursement à l'étiquette.

Admin → la commande → **Rembourser 4,90 € via le prestataire**. Attendu :
« Remboursée », un seul e-mail de remboursement dans Gmail, le colis toujours
« Expédiée » sur la fiche.

Puis, comme à l'étape 10, §10 :

- Réglages → Paiements → Carte (Stripe) : **Supprimer** les deux champs,
  **Enregistrer** : « Hors service » ;
- Stripe → Clés API → « pilote-certif production relais » → **Supprimer** ;
- Produits → « Article de certification » : décocher **Actif**.

**La fenêtre se ferme ici** : noter l'heure.

```sh
qp "SELECT status, refunded_cents FROM orders WHERE public_id = '$O'" > "$R/reel/commande-remboursee.json"
qp "SELECT COUNT(*) AS commandes FROM orders" > "$R/reel/commandes-apres.json"
qp "SELECT key FROM settings WHERE key LIKE 'enc:stripe_%'" > "$R/reel/cles-stripe-apres.json"
```

Attendu : `refunded`, 490 ; une commande de plus qu'en B1, la vôtre ; plus
aucune clé Stripe.

### B7. Le dépôt, puis le retrait (quelques jours)

- **Le dépôt** : le colis au point de dépôt Mondial Relay, l'étiquette
  scannée. Quelques heures plus tard, le lien de l'e-mail d'expédition montre
  le dépôt.
- **Le retrait** : à l'avis de Mondial Relay (SMS ou e-mail), au point choisi
  en B4, avec le code ou la pièce d'identité qu'il demande. Noter le délai
  annoncé pour retirer le colis : le [runbook des points relais](../operations/runbooks/point-relais.md)
  en a besoin.
- Après le retrait : le lien de l'e-mail d'expédition montre le colis livré ;
  l'espace Boxtal aussi. Une capture de la page de suivi, rognée (ni nom, ni
  point), `suivi-livre.png`.

Relever dans le README les dates et heures de chaque événement : achat de
l'étiquette, dépôt, arrivée au point, avis, retrait.

### B8. Revenir à l'état d'avant (cinq minutes)

Une fois le colis retiré :

- Réglages → Étiquettes de transport (Boxtal) : **Supprimer** les clés de
  production, **Enregistrer**. La commande cesse de demander le téléphone, et
  le tarif relais n'est plus proposé (Livraison le dit) ;
- Boxtal : supprimer les applications API de production créées en B0 ;
- le tarif relais reste dans Livraison : sans clés, il ne sert personne, et il
  resservira.

```sh
qp "SELECT key FROM settings WHERE key LIKE 'enc:boxtal_%'" > "$R/reel/cles-boxtal-apres.json"
git restore wrangler.jsonc
```

Attendu : aucune clé Boxtal.

### B9. Les preuves de la commande réelle

```sh
grep -rl "$HOME" "$R" | xargs -r sed -i "s|$HOME|~|g"
grep -rc "$HOME" "$R" | grep -v ':0$'                # rien
grep -lE '@|ship_address' "$R"/reel/*.json           # rien
rm -rf "$J"
git status --short                                   # client/certification seulement
git switch main && git pull && git switch -c points-relais-reel
git add client/certification && git commit -m "Points relais : la commande réelle (ticket #123 du socle, lot 6)"
git push -u origin points-relais-reel && gh pr create --fill
```

Dans `client/certification/points-relais/reel/README.md` : l'heure du
paiement et la durée de la fenêtre, le prix de l'étiquette (devis v1, puis
prélèvement Boxtal), les frais de Stripe, la chronologie du colis, le délai de
garde annoncé par Mondial Relay, ce que la page de suivi a montré à chaque
étape, et tout ce qui a accroché.

## Ce qui coche le plan

| Ligne du plan (§13.3, lot 6) | Preuve | Attendu |
|---|---|---|
| la campagne en doublure sur le bac à sable | `bac-a-sable/` : `commande-relais.json`, `reservation-relais.json`, `etiquette-relais.json`, `suivi-relais.json`, `commande-domicile.json`, `etiquette-domicile.json`, les captures, le README | une commande en relais et une à domicile payées par carte via `/checkout`, Stripe sans adresse, une étiquette de chaque sorte avec son suivi et son URL |
| Stripe Tax sur une session sans adresse de livraison | `commande-taxe.json`, README | la taxe calculée sur l'adresse de facturation, ou le refus de Stripe relevé et corrigé |
| la liste des points sans JavaScript et sur un téléphone | `points.png`, `telephone-points.png`, README | un formulaire, lisible, sans défilement horizontal |
| une recherche sans point ne bloque pas la commande | `sans-point.png` | Colissimo seul, sans erreur |
| en réel jusqu'au retrait d'un vrai colis en relais | `reel/` : `commande.json`, `etiquette.json`, `suivi.json`, `suivi-livre.png`, le README | une commande live en relais, une étiquette Mondial Relay réelle, le colis retiré au point choisi |
| l'URL de suivi vérifiée | `suivi.json`, `suivi-livre.png` | l'URL rendue par Boxtal mène à la page de Mondial Relay du colis, jusqu'à sa livraison |
| la boutique revenue à l'état d'avant | `commande-remboursee.json`, `cles-stripe-apres.json`, `cles-boxtal-apres.json`, `commandes-apres.json` | remboursée, aucune clé, aucune autre commande |

## Ce qui ferme le lot 6

Les deux pull requests de preuves du pilote vertes et fusionnées, données dans
le thread. Puis, dans le socle : le lot 6 coché au plan, le tag qui a passé la
campagne nommé à côté de `features.relayPoints` (`src/store.config.example.ts`
et le §13.3), le délai de garde de Mondial Relay dans le runbook. À partir de
ce tag, une boutique qui allume l'option hérite de la certification du socle
([ADR 0020](../architecture/decisions/0020-expeditions-par-boxtal.md),
[parcours court](par-boutique.md)).
