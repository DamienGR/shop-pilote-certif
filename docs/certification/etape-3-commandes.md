# Étape 3 — Staging sur le compte A : les commandes (jalon 10)

Fiche de passage pour le poste de Damien. Elle suit l'étape 3 du
[plan](plan.md#étape-3--staging-sur-le-compte-agence), qui décrit les quatre
trous qu'elle contourne. Elle a été répétée le 2026-10-12 dans un conteneur,
contre une boutique `pilote-certif` créée depuis `v0.3.2` et un `wrangler` de
doublure qui voit deux comptes, comme la session de Damien : provision
(simulation, réel, second passage, mauvais compte), déploiement, import du
catalogue deux fois. `npm run verify` a aussi tourné dans l'arbre de la
boutique avec la configuration de staging : vert.

Les valeurs entre chevrons sortent du gestionnaire de mots de passe ; aucune
ne transite par une conversation ni par un argument de commande.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé |
|---|---|
| Cloudflare A | Worker `minshop-pilote-certif-staging` et son domaine personnalisé sur le nom d'hôte de preview (wrangler crée l'enregistrement DNS, et **remplacerait sans demander** un enregistrement existant sur ce nom) ; base D1 `minshop-pilote-certif-staging-db` ; buckets R2 `minshop-pilote-certif-staging-images`, `-files`, `-backups`, tous en juridiction `eu`, avec une règle d'expiration à 90 jours sur `-backups` ; namespace KV `minshop-pilote-certif-staging-session` (créé par wrangler au premier déploiement) ; secrets du Worker `AUTH_SECRET` et `SECRETS_KEK` ; les migrations ; le catalogue témoin (20 produits, 4 catégories, 8 images) |
| Zero Trust (A) | une application Access de contournement sur le seul chemin `/api/webhook` ; un jeton de service et une politique « Service Auth » sur l'application de preview |
| Stripe, mode test | deux clés restreintes (boutique, nocturne) ; un endpoint de webhook vers la preview ; des sessions de checkout test que le nocturne crée puis expire |
| Resend | une clé API (envoi seul) ; des e-mails de test vers votre adresse |
| GitHub `shop-pilote-certif` | dans `staging` : secrets `STRIPE_TEST_SECRET_KEY`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`, `MINSHOP_ADMIN_PASSWORD`, `NIGHTLY_EMAIL_TO` ; `Nightly` réactivé ; une pull request de preuves |
| Cloudflare B, `canari-certif`, Stripe live | rien |

Tout tient dans les offres gratuites. Le cron du Worker (toutes les cinq
minutes) fait 288 invocations par jour.

## Quatre contournements, tant que la boutique porte `v0.3.2`

La répétition a trouvé quatre trous du socle, corrigés par la pull request #53
et livrés avec `v0.3.3`, publiée pendant l'étape 3. D'ici là :

1. **`CLOUDFLARE_ACCOUNT_ID` exporté**, égal au compte A. Sans lui, `shopctl`
   vérifie le compte mais wrangler, qui voit A et B, refuse de choisir
   (« More than one account available »), ou prend celui qu'il a en cache.
2. **`--url https://<preview>` sur `deploy`.** Sinon le test de fumée ne
   trouve pas l'origine dans la sortie de wrangler et le déploiement finit
   rouge après le téléversement.
3. **`npm run verify` et `npm run build` à part**, puis
   `deploy --skip-verify --skip-build --json`. Sinon leur sortie se mêle au
   rapport JSON.
4. **Turnstile : clés enregistrées, case « Enable Turnstile » décochée.** Le
   contrôle d'e-mail du nocturne `v0.3.2` ne sait pas passer Turnstile ; on
   coche la case après la montée en `v0.3.3`.

## 0. Shell propre

```sh
cd <chemin>/shop-pilote-certif
git switch main && git pull && git status --short     # rien
nvm use 22 && npm ci && npm ci --prefix mcp
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_API_TOKEN_STAGING CLOUDFLARE_API_TOKEN_PRODUCTION
export CLOUDFLARE_ACCOUNT_ID=$(awk '/^  accountId:/ {print $2}' client/client.yaml)   # contournement 1
export PREVIEW=$(awk '/^  stagingDomain:/ {print $2}' client/client.yaml)
echo "$CLOUDFLARE_ACCOUNT_ID $PREVIEW"               # A et le nom d'hôte de preview
npx wrangler whoami                                  # A et B listés
npm run shopctl -- doctor
mkdir -p client/certification/etape-3
```

`CLOUDFLARE_API_TOKEN` reste absent : wrangler passe par la session de
`wrangler login`.

## 1. Provisionner

```sh
npm run shopctl -- provision --env staging --dry-run
npm run -s shopctl -- provision --env staging --json > client/certification/etape-3/provision-1.json; echo $?
npm run -s shopctl -- provision --env staging --json > client/certification/etape-3/provision-2.json; echo $?
```

Attendu : `0` deux fois. `provision-1` : quatre `create`, la juridiction `eu`
relue sur la base et les trois buckets, `-files` et `-backups` privés,
migrations appliquées, secrets « en attente » (le Worker n'existe pas
encore). `provision-2` : quatre `keep`, rien de créé.

Si `jurisdictionChecks` donne `reported: null` pour la base, l'API D1 ne
publie pas le champ : faire une capture de la juridiction dans le tableau de
bord (D1 → la base) et la verser avec les preuves.

Le mauvais compte :

```sh
npm run -s shopctl -- provision --env staging --account <ID compte B> --json > client/certification/etape-3/provision-mauvais-compte.json; echo $?
```

Attendu : `4`, « deux sources désignent des comptes différents », et rien de
lu sur le compte au-delà de `whoami`.

## 2. Déployer

`provision` vient de rendre `wrangler.jsonc` pour staging : la vérification et
le build se font dessus, comme `deploy` les ferait (contournement 3).

```sh
npm run verify
npm run build
npm run -s shopctl -- deploy --env staging --skip-verify --skip-build --url "https://$PREVIEW" --json > client/certification/etape-3/deploy.json; echo $?
```

Attendu : `0`, `smoke.results` avec `/` en 302 (la redirection d'Access).
Si le test de fumée échoue sur une erreur TLS ou réseau juste après ce
premier déploiement, le certificat du domaine n'est pas encore émis :
attendre deux minutes et relancer la même commande, qui ne recrée rien.

```sh
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' "https://$PREVIEW/"
curl -s -o /dev/null -w '%{http_code}\n' "https://minshop-pilote-certif-staging.<sous-domaine workers.dev du compte A>.workers.dev/"
npm run -s shopctl -- provision --env staging --json > client/certification/etape-3/provision-3.json; echo $?
```

Attendu : 302 vers `<équipe>.cloudflareaccess.com` ; tout sauf 200 sur
`workers.dev` (le sous-domaine est dans Workers & Pages, à droite de la vue
d'ensemble) ; `provision-3` : `AUTH_SECRET` et `SECRETS_KEK` « conservés ».

## 3. Mot de passe de l'administration

Dans le navigateur : `https://<preview>/admin/setup`, code Access reçu par
e-mail, puis l'assistant. Le mot de passe va dans le gestionnaire, et dans
GitHub :

```sh
gh secret set MINSHOP_ADMIN_PASSWORD --env staging --repo DamienGR/shop-pilote-certif   # colle à l'invite, rien à l'écran
curl -s -o /dev/null -w '%{http_code}\n' "https://$PREVIEW/admin/setup"                # 302 d'Access, toujours
```

## 4. Access : le webhook, et le jeton du nocturne

Zero Trust (compte A) → Access → Applications :

- **Ajouter** une application Self-hosted « pilote-certif webhook » : nom
  d'hôte de preview avec le chemin `api/webhook`, puis un second nom d'hôte
  public, le même avec `api/webhook/*`. Une seule politique : action
  **Bypass**, inclure « Everyone ».

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' "https://$PREVIEW/api/webhook"
  ```

  Attendu : `400` (le Worker refuse la signature absente), pas `302`.

- Access → Service credentials → **Créer un jeton de service**
  « pilote-certif nocturne ». L'identifiant et le secret ne s'affichent
  qu'une fois : les coller tout de suite.

  ```sh
  gh secret set CF_ACCESS_CLIENT_ID --env staging --repo DamienGR/shop-pilote-certif
  gh secret set CF_ACCESS_CLIENT_SECRET --env staging --repo DamienGR/shop-pilote-certif
  ```

- Sur l'application de **preview** (celle de l'étape 1) : ajouter une
  politique d'action **Service Auth** qui inclut ce jeton.

## 5. Le catalogue témoin

```sh
C=test/fixtures/clients/pilot-fr/catalogue/catalog.csv
npm run shopctl -- catalog import $C --remote --env staging --create-categories --dry-run
npm run -s shopctl -- catalog import $C --remote --env staging --create-categories --json > client/certification/etape-3/catalog-import-1.json; echo $?
npm run -s shopctl -- catalog import $C --remote --env staging --create-categories --json > client/certification/etape-3/catalog-import-2.json; echo $?
npm run shopctl -- catalog report --remote --env staging
```

Attendu : le premier crée 20 produits, 9 variantes, 4 catégories et envoie
8 images ; le second a `statements: 0` et `changes` vide ; le rapport compte
20 produits, 4 catégories, 8 médias.

## 6. Les clés dans l'administration

`https://<preview>/admin/settings` :

- **Payments** — Stripe, mode test. Créer une clé restreinte « boutique » :
  Checkout Sessions en écriture, Shipping Rates en lecture, Refunds en
  écriture. Puis Développeurs → Webhooks → endpoint
  `https://<preview>/api/webhook`, cinq événements :
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`,
  `charge.refunded`. La clé et le secret de signature (`whsec_…`) se collent
  ici.
- **Email** — Resend, clé « Sending access » limitée au domaine d'envoi.
  Puis le bouton d'e-mail de test, vers votre adresse : il doit arriver.
- **Bot protection** — les clés de test de Cloudflare (décision du
  2026-10-12, [guide de l'étape 1, §6](comptes-et-acces.md#6-turnstile)) :
  clé de site `1x00000000000000000000AA`, clé secrète
  `1x0000000000000000000000000000000AA`. **Laisser « Enable Turnstile »
  décoché** jusqu'à `v0.3.3` (contournement 4).

## 7. Le nocturne

Une clé Stripe restreinte « nocturne », mode test, Checkout Sessions en
écriture seulement :

```sh
gh secret set STRIPE_TEST_SECRET_KEY --env staging --repo DamienGR/shop-pilote-certif
gh secret set NIGHTLY_EMAIL_TO --env staging --repo DamienGR/shop-pilote-certif        # l'adresse de test, à l'invite
gh workflow enable Nightly --repo DamienGR/shop-pilote-certif
gh workflow run Nightly --repo DamienGR/shop-pilote-certif
gh run watch --repo DamienGR/shop-pilote-certif
```

Attendu : `Staging (pilote-certif)` vert (sauvegarde, restauration locale,
portes distantes, supervision, Stripe, e-mail). `Production error rate and
quotas` est vert avec un avertissement : son jeton n'arrive qu'à l'étape 9.
Le dépôt est public, ses journaux aussi : l'adresse de test y est masquée
parce qu'elle est un secret. Posée en variable, comme la première version de
cette fiche le disait, elle s'affiche en clair dans l'en-tête de l'étape
(constaté le 2026-10-13) ; le nocturne le signale depuis `v0.3.4`.

## 8. Les preuves

`wrangler.jsonc` est rendu pour staging : il ne se commite pas.

```sh
git restore wrangler.jsonc
git switch -c certification-etape-3
git add client/certification && git commit -m "Certification, étape 3 : rapports de provision, deploy et catalog"
git push -u origin certification-etape-3
gh pr create --fill
```

## Ce qui ferme l'étape

La pull request des preuves verte, et le lien du run `Nightly`. Les donner
dans le thread : les rapports se relisent de là, puis le plan est coché.
