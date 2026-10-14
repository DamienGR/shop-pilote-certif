# Étape 4 — Fonctionnel et paiement en mode test : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 4 du
[plan](plan.md#étape-4--fonctionnel-et-paiement-en-mode-test). Elle a été
répétée le 2026-10-13 dans un conteneur, contre le Worker construit de
`pilote-certif` (`v0.3.3`, son propre arbre), le catalogue témoin, et Stripe et
Resend simulés : les quatre commandes ci-dessous, le webhook rejoué, les deux
remboursements, l'expédition, la panne de Resend rattrapée par le cron,
l'export et la pagination. Tout est passé, avec trois défauts que la boutique
montrera encore en `v0.3.3` (voir plus bas) et un trou du catalogue témoin.

Rien ne touche Cloudflare au-delà du staging déjà en place : l'étape passe par
le navigateur, le tableau de bord Stripe (mode test), Resend et quelques
lectures de D1.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé ou modifié |
|---|---|
| Staging `pilote-certif` (D1 sur A) | quatre commandes de test (A à D) et leur stock décrémenté ; les quatre pages légales publiées, textes `[À COMPLÉTER]` compris (leur relecture est l'étape 11), et ajoutées au pied de page ; le destinataire des alertes de commande ; cinq produits de pagination, créés puis désactivés |
| Stripe, mode test | un coupon de 10 % et son code `CERTIF10` ; quatre paiements par cartes de test ; un remboursement partiel et un total ; deux événements renvoyés |
| Resend | la clé actuelle **révoquée**, une nouvelle clé (envoi seul) ; une quinzaine d'e-mails vers votre adresse de test |
| GitHub `shop-pilote-certif` | une pull request de preuves |
| Cloudflare (Workers, R2, Access, DNS), compte B, `canari-certif`, Stripe live | rien |

Les commandes de test restent dans le staging : la production de l'étape 9 est
saisie sur B, pas recopiée (ADR 0015), et le staging est détruit à la fin de
cette étape-là. L'étape 8 s'en servira pour `privacy export` et `anonymize`.

## Ce que la boutique montre encore en `v0.3.3`

La répétition a trouvé trois défauts, corrigés dans le socle après `v0.3.3` et
livrés avec `v0.3.4` (montée de version de l'étape 5). Ils ne bloquent aucune
ligne de cette étape ; notez-les en passant, ils disparaissent à la montée.

1. **« Free shipping »** : au-delà de 60 €, l'option gratuite que la page de
   Stripe affiche, et que la commande enregistre, porte un libellé anglais.
   « Livraison offerte » en `v0.3.4`.
2. **La TVA manque dans la version texte des e-mails** de confirmation et
   d'alerte : la version HTML, celle qu'affiche votre messagerie, porte bien
   « dont TVA (20 %) ».
3. **Publier une page ne la met pas dans le pied de page.** Le pied de page
   est un menu : chaque page légale s'y ajoute dans Admin → Navigation
   (section 2). Comportement voulu, que la documentation du socle décrivait
   mal.

Et un trou du catalogue témoin : vingt produits pour vingt-quatre par page, la
pagination n'apparaît jamais. La section 9 ajoute cinq produits le temps de la
voir.

## 0. Shell propre

```sh
cd <chemin>/shop-pilote-certif
git switch main && git pull && git status --short     # rien
nvm use 22 && npm ci
unset CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)
export PREVIEW=$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)
echo "$CLOUDFLARE_ACCOUNT_ID $PREVIEW"               # A et le nom d'hôte de preview
DB_ID=$(npx wrangler d1 list --json | node -e 'const l = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(l.find((d) => d.name === "minshop-pilote-certif-staging-db").uuid)')
node scripts/prepare-client.mjs pilote-certif --env staging --database-id "$DB_ID"
mkdir -p client/certification/etape-4
q() { npx wrangler d1 execute minshop-pilote-certif-staging-db --remote --json --command "$1"; }
```

`wrangler.jsonc` est rendu pour staging : `catalog import` (section 9) le
refuse autrement, et `q` y trouve la base. Il ne se commite pas (section 10).
`CLOUDFLARE_ACCOUNT_ID` reste exporté : `shopctl` épingle le compte depuis
`v0.3.3`, pas un `wrangler` lancé à la main, qui voit A et B. `q` lit la base
de staging ; ses lectures ne prennent jamais `email` ni `ship_address`, parce
que les preuves vont dans un dépôt public.

Le stock et les commandes avant de commencer :

```sh
STOCK="SELECT sku, stock FROM products WHERE sku IN ('BOU-CIR','CAR-A5','ECH-LAI','TOR-LIN','BAU-LEV') UNION ALL SELECT sku, stock FROM product_variants WHERE sku = 'TEE-M' ORDER BY sku"
q "$STOCK" > client/certification/etape-4/stock-avant.json
q "SELECT COUNT(*) AS commandes FROM orders"
```

Attendu, au catalogue témoin : BAU-LEV 25, BOU-CIR 7, CAR-A5 4, ECH-LAI 6,
TEE-M 3, TOR-LIN 22 ; aucune commande. Évitez la fenêtre du `Nightly`
(03:17 UTC) : son contrôle Stripe tient une unité le temps d'expirer sa
session.

## 1. Réglages et code promotionnel

`https://<preview>/admin/settings` :

- **Email → New-order alerts to** : votre adresse de test. C'est elle qui
  reçoit l'alerte de chaque commande.
- **Features → Discount codes** : coché (c'est le défaut).

Stripe, mode test → Catalogue de produits → **Coupons** → créer un coupon
« Certification 10 % », pourcentage 10, durée « une fois » ; puis, sur ce
coupon, un **code promotionnel** `CERTIF10`.

## 2. Pages légales et case CGV

- Admin → **Pages** : publier les quatre pages (conditions générales de vente,
  mentions légales, politique de confidentialité, droit de rétractation),
  telles quelles.
- Admin → **Navigation** → Footer : ajouter les quatre.
- Sur la boutique : les quatre liens au pied de chaque page, et chacun ouvre
  sa page. Dans le panier, avec un article : la case « J'ai lu et j'accepte
  les conditions générales de vente (Version 1) ».
- Le refus côté serveur : outils de développement, retirer l'attribut
  `required` de la case, laisser décoché et commander. Attendu : retour au
  panier avec « Vous devez accepter les conditions générales de vente pour
  commander. », sans passer par Stripe, et `q "$STOCK"` inchangé.

## 3. Les commandes

Cartes de test Stripe : n'importe quelle date future, n'importe quel CVC. Le
nom et l'adresse de livraison sont libres ; l'e-mail est votre adresse de
test. Le stock est **tenu dès le clic sur « Commander »** : une page Stripe
abandonnée garde son unité jusqu'à l'expiration de la session (30 minutes).

| | Où | Panier | Sur Stripe | Carte | Total attendu | dont TVA |
|---|---|---|---|---|---|---|
| A | ordinateur | Bougie de cire d'abeille | Colissimo | `4242 4242 4242 4242` | 23,90 € | 3,98 € |
| B | ordinateur | Tee-shirt en coton bio, taille M + Carnet recyclé A5 | `CERTIF10`, Colissimo | `4242 4242 4242 4242` | 44,06 € (42,40 − 4,24 + 5,90) | 7,34 € |
| C | téléphone | Écharpe en laine mérinos + Torchon en lin | l'option gratuite (« Free shipping ») | `4000 0025 0000 3155` (3-D Secure : « Compléter ») | 63,00 € | 10,50 € |

Sur le téléphone, Access demande son code par e-mail comme sur l'ordinateur.
D, la quatrième, est à la section 7.

Pour chacune, attendu :

- la page de confirmation de la boutique, avec le total et « dont TVA » ;
- deux e-mails : la confirmation (remise et TVA y compris pour B) et l'alerte
  de commande ;
- dans Admin → Orders, la commande payée, CGV acceptées version 1 ;
- le stock des articles, un de moins.

Pour B, la remise s'applique aux articles et jamais au port : c'est Stripe qui
la calcule, et la TVA est prise sur le total remisé. Pour C, la page de Stripe
doit montrer trois options (gratuite, Colissimo 5,90 €, express 12,90 €) parce
que le panier passe 60 €.

```sh
q "$STOCK" > client/certification/etape-4/stock-apres-commandes.json
```

Attendu : BOU-CIR, CAR-A5, ECH-LAI, TEE-M, TOR-LIN un de moins chacun ;
BAU-LEV inchangé.

## 4. Le webhook rejoué

Stripe → Développeurs → **Webhooks** → l'endpoint de la preview → l'événement
`checkout.session.completed` de A → **Renvoyer**.

Attendu : Stripe affiche une réponse 200 ; aucun e-mail ; et

```sh
q "SELECT provider_session_id, COUNT(*) AS n FROM orders GROUP BY provider_session_id" > client/certification/etape-4/une-commande-par-session.json
q "$STOCK"
```

une ligne par session, `n` à 1 partout ; stock identique à la lecture
précédente.

## 5. Remboursements depuis Stripe

Stripe → **Paiements** → le paiement de A (23,90 €) → Rembourser **5,00 €**.
Puis, une fois l'e-mail reçu, Rembourser le reste (18,90 €).

Attendu après le premier : A reste `paid` avec 5,00 € remboursés (Admin →
Orders → A), un e-mail de remboursement de 5,00 €. Après le second : A passe
`refunded`, un second e-mail de 18,90 €. Un remboursement ne remet rien en
stock : le colis peut être parti.

Puis Webhooks → le **premier** `charge.refunded` de A → Renvoyer. Attendu :
200, rien ne bouge, aucun e-mail.

```sh
q "SELECT provider_event_id, status, cumulative_refunded_cents FROM refund_sync_events ORDER BY created_at" > client/certification/etape-4/remboursements.json
```

## 6. Expédition

Admin → Orders → B → Carrier « Colissimo », tracking `6A00000000000` (fictif)
→ **Mark as fulfilled**.

Attendu : B « fulfilled », et l'e-mail « Votre commande … est expédiée » avec
le numéro de suivi.

## 7. Resend indisponible

À faire d'une traite : à partir de la commande, il reste **un quart d'heure**
pour rendre une clé. Le cron réessaie toutes les cinq minutes une ligne vieille
de plus de deux minutes ; à la cinquième tentative (vers vingt minutes), il la
range comme morte et la ligne échoue.

1. Resend → API Keys → la clé de la boutique → **supprimer** (la révoquer).
2. Commande **D**, sur l'ordinateur : Baume à lèvres calendula, Colissimo,
   `4242 4242 4242 4242`. Total 13,40 €, dont TVA 2,23 €.
3. Attendu : la page de confirmation, la commande dans Admin → Orders, et
   aucun e-mail.

   ```sh
   N="SELECT o.public_id, n.kind, n.state, n.attempts, n.last_error, n.sent_at FROM order_notifications n JOIN orders o ON o.id = n.order_id WHERE o.public_id = (SELECT public_id FROM orders ORDER BY id DESC LIMIT 1)"
   q "$N" > client/certification/etape-4/resend-en-panne.json
   ```

   `customer-receipt` et `owner-notification` en `pending`, 1 tentative,
   `Resend send failed (401)`.
4. Resend → créer une clé « Sending access » limitée au domaine d'envoi ;
   Admin → Settings → Email → la coller, enregistrer.
5. Attendre les deux e-mails (au plus cinq minutes de plus), puis

   ```sh
   q "$N" > client/certification/etape-4/resend-rattrape.json
   ```

   les deux lignes en `sent`, 2 à 4 tentatives.

Le bouton d'e-mail de test des réglages doit de nouveau passer : c'est lui que
le `Nightly` utilise.

## 8. Le parcours du §8.1, et l'export

Sur l'ordinateur, puis sur le téléphone :

| Ligne | Ce qui se voit |
|---|---|
| catalogue | l'accueil, les cartes, une fiche avec ses images |
| recherche | « lin » trouve le cabas, le torchon et la nappe ; « l'été » ne casse rien |
| catégories | maison, papeterie, soins, textile |
| pagination | section 9 |
| variantes | Tee-shirt : L épuisée, XL à 32,90 € ; Chaussettes : 42-44 épuisée |
| stock | Mug en grès et Cartes de vœux épuisés, sans bouton d'achat |
| panier | ajouter, changer la quantité, retirer |
| livraison | Colissimo et express sous 60 €, l'option gratuite au-delà (C) |
| promotions | `CERTIF10` (B) |
| paiement | A, B, C, D ; 3-D Secure sur C |
| remboursement | section 5 |
| e-mails | confirmation, alerte, expédition, remboursement, et D rattrapée |
| administration | Orders, une commande, Settings, Pages, Navigation |
| export | ci-dessous |
| pages légales | section 2 |

Admin → Orders → **Export CSV**. Le fichier porte votre adresse dans la
colonne `Email` : elle se masque avant d'aller dans le dépôt public, et ses fins
de ligne CRLF deviennent LF, que la porte de format de la boutique exige.

```sh
awk -F, -v OFS=, '{ sub(/\r$/, "") } NR > 1 { $3 = "masquee" } 1' ~/Downloads/orders.csv > client/certification/etape-4/export-commandes.csv
cut -d, -f1,4,8,10,16,19,21,24 client/certification/etape-4/export-commandes.csv
```

Attendu : quatre commandes ; B avec `Discount` 4.24 et `VAT included` 7.34 et
son suivi ; A `refunded`, `Refund state` à `full` ; `Terms version` à 1
partout.

## 9. Pagination : cinq produits le temps de la voir

```sh
P=client/certification/etape-4/pagination.csv
cat > $P <<'EOF'
sku;product;name;slug;description;variant_group;variant;price;stock;weight_grams;requires_shipping;active;categories;images
PAG-01;;Produit de pagination 1;;Produit de test de l'étape 4, désactivé ensuite.;;;1,00;5;50;oui;oui;papeterie;
PAG-02;;Produit de pagination 2;;Produit de test de l'étape 4, désactivé ensuite.;;;1,00;5;50;oui;oui;papeterie;
PAG-03;;Produit de pagination 3;;Produit de test de l'étape 4, désactivé ensuite.;;;1,00;5;50;oui;oui;papeterie;
PAG-04;;Produit de pagination 4;;Produit de test de l'étape 4, désactivé ensuite.;;;1,00;5;50;oui;oui;papeterie;
PAG-05;;Produit de pagination 5;;Produit de test de l'étape 4, désactivé ensuite.;;;1,00;5;50;oui;oui;papeterie;
EOF
npm run -s shopctl -- catalog import $P --remote --env staging --json > client/certification/etape-4/pagination-ajout.json; echo $?
```

Attendu : `0`, cinq produits créés. Sur la boutique : l'accueil propose une
page 2, qui montre le vingt-cinquième produit. Puis :

```sh
sed -i.bak 's/;oui;oui;papeterie;$/;oui;non;papeterie;/' $P && rm $P.bak
npm run -s shopctl -- catalog import $P --remote --env staging --json > client/certification/etape-4/pagination-retrait.json; echo $?
```

Attendu : `0`, cinq produits mis à jour ; plus de page 2.

## 10. Les preuves

```sh
q "SELECT public_id, provider_session_id, provider_payment_id, status, amount_total_cents, shipping_cents, shipping_label, discount_cents, vat_rate_bps, vat_amount_cents, refunded_cents, fulfillment_status, tracking_carrier, terms_version, terms_accepted_at, created_at FROM orders ORDER BY id" > client/certification/etape-4/commandes.json
q "$STOCK" > client/certification/etape-4/stock-fin.json
git restore wrangler.jsonc
git switch -c certification-etape-4
git add client/certification && git commit -m "Certification, étape 4 : commandes, remboursements, e-mails et export en mode test"
git push -u origin certification-etape-4
gh pr create --fill
```

Dans `client/certification/etape-4/README.md`, une ligne par commande : sa
lettre, son `pi_…`, le montant que Stripe affiche pour ce paiement, et ce que
vous avez vu (e-mails reçus, mobile ou ordinateur). Pas de capture qui montre
votre adresse.

## Ce qui ferme l'étape

La pull request des preuves, verte. La donner dans le thread : les montants de
Stripe se comparent à `commandes.json`, puis le plan est coché.
