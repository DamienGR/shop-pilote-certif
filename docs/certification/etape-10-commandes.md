# Étape 10 — Argent réel : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 10 du
[plan](plan.md#étape-10--argent-réel) : le pilote monte en `v0.3.22` et la
production est redéployée ; une clé Stripe live et le secret de son webhook
entrent dans le coffre de la production ; un produit à 1 € est acheté avec une
vraie carte, la commande est relevée de Stripe à l'e-mail, puis remboursée
depuis l'administration ; les e-mails sont lus dans trois messageries, le reçu
de Stripe est décidé ; enfin les clés sont retirées, et la boutique revient à
l'état de la fin de l'étape 9.

Elle a été répétée le 2026-10-23 dans un conteneur, contre le Worker construit
du socle (`v0.3.21`) mis dans l'état de la production de B à la fin de
l'étape 9 (installée, mot de passe posé, démonstration coupée, Resend, pages
légales publiées, catalogue), Stripe en mode live et Resend simulés : les clés
saisies dans Réglages, le produit à 1 € créé dans l'administration, l'achat
par le panier, le webhook signé, la commande de 6,90 € et sa TVA de 1,15 €, le
stock à zéro, la confirmation et l'alerte, le remboursement par le bouton de
l'administration (la session relue, `refunds.create` avec la clé live), le
`charge.refunded` qui suit sans rien doubler, l'e-mail de remboursement envoyé
une fois, puis les clés supprimées et le panier refermé. Le chemin tient ;
deux défauts, corrigés dans `v0.3.22`.

## Ce que la répétition a trouvé

Corrigé dans `v0.3.22` (`docs/migrations/v0.3.22.md`) :

1. **Une clé de test passait commande en production.** Collée dans le coffre de
   la production, une clé `rk_test_…` ouvrait une session de test que la carte
   `4242 4242 4242 4242` payait, et le webhook signé écrivait une commande
   payée, envoyait « Nouvelle commande » au commerçant et sortait l'unité du
   stock. Le Worker ne savait pas qu'il était la production. Le rendu y écrit
   `MINSHOP_ENV` : la production refuse une clé de test à l'enregistrement
   (section 3 le vérifie), ne construit pas Stripe sur une clé de test
   enregistrée avant, et refuse un événement du mode test. La carte de
   Réglages dit le mode de la clé.
2. **L'alerte du commerçant numérotait la commande autrement.** « Nouvelle
   commande Certif Minshop n°1 - ord_2vgje1r0cb » pour une commande que le
   client, l'administration et l'export appellent « n°2vgje1r0cb » : le « 1 »
   était l'identifiant de ligne de la base. Elle porte le numéro du client.

Vu, et voulu :

- **un remboursement ne remet rien en stock** : le colis peut être parti
  (étape 4). Le produit reste épuisé ; le commerçant remet son stock à la main
  si l'article revient ;
- **le bouton de l'administration enregistre le remboursement aussitôt**, et le
  `charge.refunded` qui suit ne change rien : un seul remboursement, un seul
  e-mail ;
- **un événement arrivé après le retrait des clés** reçoit un 400, que Stripe
  relance. Il n'en vient aucun tant qu'aucune session n'est ouverte.

Non répétés, faute de doublure : l'activation du mode live, la page hébergée
de Stripe et l'authentification 3-D Secure, les frais et le solde réels, le
reçu de Stripe, le rendu des e-mails dans de vraies messageries.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare B | la production de `pilote-certif` redéployée en `v0.3.22` ; dans sa base, le produit « Article de certification » (1 €, puis désactivé), une commande payée puis remboursée, ses deux clés Stripe entrées puis supprimées |
| Stripe live | une clé restreinte « pilote-certif production », créée puis supprimée ; un endpoint de webhook sur la production, gardé ; un paiement de 6,90 € et son remboursement total ; les frais du paiement (de l'ordre de 0,35 €), que le remboursement ne rend pas |
| Resend | trois e-mails réels : la confirmation et le remboursement vers votre adresse Gmail, l'alerte vers votre adresse Outlook |
| GitHub `shop-pilote-certif` | la pull request `socle/v0.3.22`, un run `Deploy` approuvé, une pull request de preuves |
| Cloudflare A, `canari-certif`, Stripe test | rien |

**La fenêtre** : de la section 3 à la section 10, la production prend de vrais
paiements pour tout son catalogue, les vingt produits témoins compris. La
tenir courte (une demi-heure suffit), et relever à la fin qu'aucune autre
commande n'est arrivée.

## 0. Shell propre, et ce qui doit exister avant

Prérequis : le tag `v0.3.22`, publié par le workflow `Release` du socle.

Dans Stripe, mode **live** (l'interrupteur « Mode test » coupé) :

- [ ] l'activation terminée : Paramètres → Entreprise, plus rien à fournir, les
  paiements et les virements activés, le libellé de relevé bancaire choisi ;
- [ ] la double authentification active sur le compte.

Pour la section 9, trois messageries : une adresse **Gmail** (l'acheteur), une
adresse **Outlook.com** (les alertes de commande), et **Apple Mail** sur un Mac
ou un iPhone, qui relève la boîte Gmail. Sans appareil Apple, la ligne passe
sous dérogation, comme l'achat sur Safari de l'étape 6.

```sh
P=<chemin>/shop-pilote-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
cd "$P" && nvm use 22
gh repo set-default DamienGR/shop-pilote-certif
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID    # shopctl lit le compte de chaque environnement dans le manifeste
COMPTE_B=$(awk '/^  productionAccountId:/ {print $2}' client/client.yaml)
export PROD="https://$(awk '/^  productionDomain:/ {print $2}' client/client.yaml)"
E="$P/client/certification/etape-10" && mkdir -p "$E"
J=$(mktemp -d)                                       # hors du dépôt : cookies
# Lectures de la base de production. Jamais email ni ship_address : les preuves vont dans un dépôt public.
q() { CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler d1 execute minshop-pilote-certif-production-db --remote --json --command "$1"; }
echo "$COMPTE_B $PROD"
```

## 1. Monter le pilote en `v0.3.22`, redéployer la production

```sh
npm run shopctl -- core upgrade --to v0.3.22 --open-pr
gh pr checks socle/v0.3.22 --watch
gh pr merge socle/v0.3.22 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.22
gh workflow run deploy.yml -f shop=pilote-certif -f environment=production
sleep 10 && R=$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') && echo "$R"
```

GitHub → Actions → ce run → **Review deployments** → `production` →
**Approve and deploy**.

```sh
gh run watch "$R"; echo $?
gh run download "$R" -D "$E/deploy-v0.3.22"
```

Attendu : la pull request verte, avec les notes jusqu'à `v0.3.22` ; dans son
diff, `wrangler.jsonc` gagne `"MINSHOP_ENV": ""` (le rendu commité n'a pas
d'environnement, le déploiement écrit `production`) ; le run vert, la
sauvegarde préalable envoyée, le test de fumée vert sans avertissement.

Puis le `wrangler.jsonc` de production sur le poste, pour `q` : `provision`
le rend sans rien créer.

```sh
npm run -s shopctl -- provision --env production --json > "$E/provision.json"; echo $?
q "SELECT COUNT(*) AS commandes FROM orders" > "$E/commandes-avant.json"
```

Attendu : `0`, rien de créé ; aucune commande.

## 2. Stripe live : la clé, l'endpoint, le reçu, les moyens de paiement

Stripe, mode live :

- **Développeurs → Clés API → Créer une clé restreinte**, nommée
  « pilote-certif production » : Checkout Sessions en **écriture**, Shipping
  Rates en **lecture**, Refunds en **écriture**, rien d'autre. Stripe ne montre
  une clé live qu'une fois : la garder dans le presse-papiers jusqu'à la
  section 3, nulle part ailleurs.
- **Développeurs → Webhooks → Ajouter une destination** : l'URL
  `https://certif-minshop.miijot.fr/api/webhook`, cinq événements :
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`. Révéler son secret de signature (`whsec_…`).
- **Paramètres → Moyens de paiement** : relever ceux que Checkout proposera
  (la carte au moins). Un moyen différé, comme le prélèvement SEPA, laisse la
  commande en attente plusieurs jours, son stock tenu.
- **Paramètres → Entreprise → E-mails aux clients → Paiements réussis** : la
  décision de la section 7, à prendre avant de payer. La boutique envoie déjà
  sa confirmation, avec la TVA (ADR 0010) ; activé, Stripe envoie en plus son
  propre reçu.

## 3. Les clés dans le coffre de la production

`$PROD/admin/settings` → **Paiements** → **Carte (Stripe)**.

D'abord, le refus que `v0.3.22` apporte : dans « Clé secrète », taper
`rk_test_essai`, dans « Secret de signature du webhook » `whsec_essai`,
**Enregistrer**. Attendu : « Clé de test refusée : cette boutique est la
production, elle n'accepte qu'une clé live (rk_live_… ou sk_live_…). […] Rien
n'a été enregistré. », et la carte toujours « Hors service ». Une capture,
`cle-test-refusee.png`. Sans ce message, `MINSHOP_ENV` n'est pas arrivé :
arrêter l'étape ici, la production n'est pas en `v0.3.22`.

Puis la clé live et le secret du webhook, **Enregistrer**. Attendu : « En
service — mode live : paiements réels », l'interrupteur de la carte activé,
« Carte (Stripe) » comme moyen de paiement par défaut. Une capture,
`cle-live.png`. Vider le presse-papiers.

**La fenêtre s'ouvre ici** : noter l'heure.

Le contrôle des champs de carte que l'étape 9 laissait « à rejouer une fois
Stripe configuré », sans `--limiteurs` : ils fermeraient la connexion à
l'administration pour un quart d'heure, et la section 8 en a besoin.

```sh
BASE_URL=$PROD npm run -s test:security:remote 2>&1 | tee "$E/porte-distante.txt"; echo $?
```

Attendu : `0`, tout vert, et « aucun champ de carte » sans « aucun moyen de
paiement configuré ». La porte ne crée aucune session.

## 4. Le produit à 1 €

Admin → Produits → **Nouveau** : nom « Article de certification », prix
`1,00`, stock `1`, **Actif**, **Nécessite une livraison** coché, poids `50 g`,
description « Paiement réel de l'étape 10, remboursé. », sans image.

Expédié plutôt que sans livraison : la commande exerce alors la collecte de
l'adresse et le droit Shipping Rates de la clé live, le seul dont l'absence ne
fait pas d'erreur (la commande s'écrit avec un mode de livraison inconnu). Le
total passe à 6,90 € avec la Colissimo du socle (si Admin → Livraison n'a
pas changé ses tarifs : la page de Stripe fait foi pour la suite), et les
frais de Stripe de 0,27 € à 0,35 € environ ; le remboursement rend le total.

```sh
q "SELECT public_id, slug, price_cents, stock, requires_shipping, weight_grams, active FROM products WHERE name = 'Article de certification'" > "$E/produit.json"
```

Attendu : `price_cents` 100, `stock` 1, `requires_shipping` 1,
`weight_grams` 50, `active` 1.

## 5. La commande réelle

Dans une fenêtre privée (sans session d'administration) :
`$PROD/products/article-de-certification` → **Ajouter au panier** → le panier
→ la case des conditions générales → **Payer par carte**.

Sur la page de Stripe, avant de payer :

- l'adresse commence par `https://checkout.stripe.com/c/pay/cs_live_` : c'est
  la preuve que la session est live. Aucun bandeau « Mode test » ;
- la page en français, « Article de certification » à 1,00 €, la livraison
  Colissimo à 5,90 €, le total 6,90 € ;
- l'e-mail : votre adresse **Gmail** ; l'adresse de livraison : la vôtre.

Payer avec une vraie carte, valider l'authentification de la banque. Noter
l'heure. Attendu : la page de commande de la boutique (« Merci pour votre
commande »), son numéro.

Dans la minute, Admin → **Commandes** : la commande, « Payée ». Absente après
deux minutes : Stripe → Webhooks → l'endpoint → les tentatives, et le
[runbook des webhooks](../operations/runbooks/webhooks-stripe.md), sections 2
et 3. Rien n'est perdu : Stripe relance, et l'événement se renvoie à la main
une fois le secret corrigé.

## 6. La cohérence : Stripe, D1, stock, administration, e-mail

```sh
O=$(q "SELECT public_id FROM orders ORDER BY id DESC LIMIT 1" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].results[0].public_id')
echo "$O"
COMMANDE="SELECT public_id, status, amount_total_cents, currency, shipping_cents, shipping_label, delivery_method, vat_rate_bps, vat_amount_cents, tax_cents, discount_cents, payment_method, provider_session_id, provider_payment_id, terms_version, refunded_cents FROM orders WHERE public_id = '$O'"
q "$COMMANDE" > "$E/commande.json"
q "SELECT name, price_cents, quantity FROM order_items WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$E/lignes.json"
q "SELECT kind, state, attempts FROM order_notifications WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$E/notifications.json"
q "SELECT stock FROM products WHERE name = 'Article de certification'" > "$E/stock-apres-commande.json"
curl -s "$PROD/products/article-de-certification" | grep -c 'Épuisé' | tee "$E/fiche-epuisee.txt"
```

| Où | Ce qu'on relève | Attendu |
|---|---|---|
| Stripe → Paiements → le paiement | montant, état, identifiant `pi_…`, frais, net | 6,90 € « Réussi » ; le même `pi_…` que `provider_payment_id` ; les frais et le net, à noter dans le README |
| `commande.json` | la commande en base | `paid`, 690, `eur`, 590 « Colissimo », `shipping`, 2000 et 115, `tax_cents` 0, `discount_cents` 0, `stripe`, `cs_live_…`, `pi_…`, `terms_version` renseignée, `refunded_cents` 0 |
| `lignes.json`, `notifications.json` | les lignes, les deux envois | une ligne à 100 × 1 ; la confirmation et l'alerte `sent` |
| stock | `stock-apres-commande.json`, `fiche-epuisee.txt` | 0 ; la fiche dit « Épuisé » |
| Admin → Commandes → la commande | ce que voit le commerçant | « Payée », 6,90 €, « Livraison 5,90 € · Colissimo · 50 g », l'adresse, et en « Référence de paiement » le `cs_live_…` que Stripe montre sur le paiement |
| Gmail | la confirmation | « Votre commande Certif Minshop n°… », 1,00 €, livraison 5,90 €, total 6,90 €, « dont TVA (20 %) : 1,15 € », le lien « Voir ma commande » |
| Outlook | l'alerte | « Nouvelle commande Certif Minshop n°… », **le même numéro** que la confirmation (`v0.3.22`), l'adresse de livraison, le lien vers l'administration |

Une capture de la commande dans l'administration (`admin-commande.png`) et
du paiement dans Stripe (`stripe-paiement.png`), sans l'adresse ni le nom :
les rogner.

## 7. Le reçu de Stripe

La décision du commerçant (vous, pour le pilote), prise en section 2 :

- **« Paiements réussis » coupé** (recommandé) : l'acheteur reçoit un seul
  e-mail, celui de la boutique, qui porte la TVA. Stripe → le paiement →
  « Historique des reçus » est vide ;
- **activé** : Stripe a envoyé son reçu à l'adresse Gmail. Il est dans
  « Historique des reçus » du paiement, et `receipt_number` est renseigné sur
  la charge (Développeurs → Événements → `charge.succeeded` → `receipt_number`).
  Le relever dans le README, avec le reçu tel que reçu.

La décision va dans le README, et dans la checklist de lancement de la
boutique : chaque commerçant la reprend.

## 8. Le remboursement total, depuis l'administration

Le bouton de la boutique plutôt que le tableau de bord de Stripe : les
étapes 4 et 5 ont remboursé depuis Stripe, et aucune fiche n'a fait tourner le
bouton contre le vrai Stripe. Il relit la session (Checkout Sessions) et crée
le remboursement (Refunds) avec la clé live.

Admin → Commandes → la commande → **Rembourser 6,90 € via le prestataire**.

```sh
q "SELECT status, refunded_cents, provider_refunded_cents, external_refunded_cents, refund_review_reason FROM orders WHERE public_id = '$O'" > "$E/commande-remboursee.json"
q "SELECT kind, status, amount_cents FROM refunds WHERE order_id = (SELECT id FROM orders WHERE public_id = '$O')" > "$E/remboursements.json"
q "SELECT status, cumulative_refunded_cents FROM refund_sync_events" > "$E/evenements-remboursement.json"
q "SELECT stock FROM products WHERE name = 'Article de certification'" > "$E/stock-apres-remboursement.json"
```

Attendu :

- la commande « Remboursée », total remboursé 6,90 €, reste remboursable
  0,00 € ; en base `refunded`, 690 et 690, 0, pas de revue ;
- un seul remboursement, `provider_sync`, `succeeded`, 690 ; un événement
  `charge.refunded`, `processed`, 690 ; sur l'endpoint de Stripe, sa livraison
  en 200 ;
- Stripe → le paiement : « Remboursé ». Un compte neuf n'a pas encore de solde
  disponible : Stripe peut laisser le remboursement « En attente » jusqu'à ce
  qu'il en ait un. Noter son état, et l'heure où il passe « Réussi » ;
- un seul e-mail de remboursement dans Gmail, « Votre commande Certif Minshop
  n°… a été remboursée », « Remboursé : 6,90 € » ;
- le stock toujours à 0 : un remboursement ne remet rien en stock (étape 4).

## 9. Les e-mails dans trois messageries

Trois e-mails : la confirmation et le remboursement (Gmail), l'alerte
(Outlook).

| Messagerie | Ce qu'on y lit |
|---|---|
| Gmail, dans le navigateur | la confirmation, le remboursement |
| Outlook.com, dans le navigateur ou l'application | l'alerte |
| Apple Mail, sur le Mac ou l'iPhone, avec le compte Gmail | la confirmation, le remboursement |

Pour chacun : arrivé en boîte de réception (pas en indésirables),
l'expéditeur `commandes@certif-minshop.miijot.fr`, les accents, le tableau des
articles et des totaux, la ligne de TVA, les liens qui ouvrent la commande ou
l'administration. Une capture par messagerie dans `$E/emails/`, rognée :
ni l'adresse, ni le nom, ni l'adresse postale.

## 10. Fermer la fenêtre

Le plan laisse le choix à l'étape 11 : clés retirées, ou boutique laissée
fermée. D'ici là, retirer les clés : le catalogue est celui du témoin, les
pages légales ne sont pas validées, et personne ne doit pouvoir payer. Les
remettre à l'ouverture prend deux minutes : une nouvelle clé restreinte, le
même secret de webhook.

- Admin → Réglages → Paiements → Carte (Stripe) : **Supprimer** sur les deux
  champs, **Enregistrer**. Attendu : « Hors service — ajoutez les deux clés
  Stripe ».
- Stripe → Développeurs → Clés API → « pilote-certif production » →
  **Supprimer** : une clé qu'aucun coffre ne porte n'a pas à vivre.
  L'endpoint de webhook reste : il ne reçoit rien tant qu'aucune session ne
  s'ouvre.
- Admin → Produits → « Article de certification » : décocher **Actif**,
  **Enregistrer**. Le produit reste, une commande y renvoie.

**La fenêtre se ferme ici** : noter l'heure.

```sh
q "SELECT COUNT(*) AS commandes FROM orders" > "$E/commandes-apres.json"
q "SELECT key FROM settings WHERE key LIKE 'enc:stripe_%'" > "$E/cles-apres.json"
curl -s "$PROD/api/products?limit=100" > "$J/produits.json"
A=$(node -p 'require(process.argv[1]).products.find((p) => p.in_stock && !p.variant_label).id' "$J/produits.json")
curl -s -o /dev/null -c "$J/panier.jar" -H "Origin: $PROD" --data "_action=add&product_id=$A" "$PROD/api/cart"
curl -s -b "$J/panier.jar" "$PROD/cart" | grep -c 'momentanément indisponible' | tee "$E/panier-ferme.txt"
git restore wrangler.jsonc
```

Attendu : une commande, la vôtre, et aucune autre pendant la fenêtre ; plus
aucune clé Stripe en base ; le panier qui dit la commande indisponible (1).

Si l'étape 11 décide plutôt de garder les clés : Admin → Réglages → Général,
couper « Panier et tunnel de commande » et « Achat immédiat ». C'est la
boutique « laissée fermée » du plan.

## 11. Les preuves

```sh
grep -rl "$HOME" "$E" | xargs -r sed -i "s|$HOME|~|g"
grep -rl "$J" "$E" | xargs -r sed -i "s|$J|<tmp>|g"
grep -rc "$HOME" "$E" | grep -v ':0$'                # rien
grep -lE '@|ship_address' "$E"/*.json "$E"/*.txt   # rien : aucune adresse dans les lectures de la base
rm -rf "$J"
git status --short                                   # client/certification seulement ; wrangler.jsonc intact
git switch -c certification-etape-10
git add client/certification && git commit -m "Certification, étape 10 : paiement réel et remboursement"
git push -u origin certification-etape-10
gh pr create --fill
```

Dans `client/certification/etape-10/README.md`, ce qui ne laisse pas de
fichier : l'heure du paiement, la durée de la fenêtre, le type de carte
(standard de l'EEE, premium, hors EEE), les frais et le net affichés par
Stripe, l'état du remboursement et l'heure où il est « Réussi », la décision
sur le reçu de Stripe, ce que chaque messagerie a montré, et tout ce qui a
accroché.

## Ce qui coche le plan

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| clés Stripe live et secret du webhook live dans le coffre de la production | `cle-test-refusee.png`, `cle-live.png`, l'URL `cs_live_…` de la section 5, `porte-distante.txt` | la clé de test refusée, « mode live », une session live, la porte verte avec Stripe configuré |
| un produit à 1 € ; commande réelle | `produit.json`, `commande.json`, `stripe-paiement.png` | 100 centimes, expédié ; une commande payée de 6,90 € sur `pi_…` |
| cohérence entre Stripe, D1, stock, administration et e-mail | la table de la section 6, ses fichiers et captures | les mêmes montants, le même `pi_…` et `cs_live_…`, le stock à 0, le même numéro dans les deux e-mails |
| remboursement total ; la commande, le stock et l'e-mail suivent | `commande-remboursee.json`, `remboursements.json`, `evenements-remboursement.json`, `stock-apres-remboursement.json`, README | `refunded` ; un remboursement, un événement ; le stock à 0, voulu ; un e-mail |
| e-mails lus dans Gmail, Outlook et Apple Mail | `emails/` | trois messageries, ou la dérogation écrite pour celle qui manque |
| le reçu de Stripe décidé avec le commerçant | README, et le reçu s'il est activé | la décision ; s'il est activé, le reçu et `receipt_number` |
| clés live retirées, ou boutique laissée fermée | `cles-apres.json`, `panier-ferme.txt`, `commandes-apres.json` | aucune clé, le panier fermé, aucune autre commande |

## Ce qui ferme l'étape

La pull request des preuves du pilote verte. La donner dans le thread : les
preuves se relisent de là, puis le plan est coché, et le critère de sortie du
jalon 7 (un paiement réel encaissé puis remboursé) avec lui.
