# Runbook — fuite d'un secret

**Déclencheurs** : un secret vu dans un dépôt, un journal, un ticket, une
capture d'écran, un message ; une alerte de scan de secrets GitHub ; le départ
d'une personne qui y avait accès ; un poste perdu.

**Règle** : on révoque d'abord, on enquête ensuite. Un secret exposé est
compromis, même si personne ne semble l'avoir utilisé. Supprimer le commit ne
suffit pas : l'historique, les forks et les caches l'ont gardé.

## 1. Identifier le secret et son propriétaire

| Secret | Où il vit | Qui le révoque | Effet de la rotation |
|---|---|---|---|
| Jeton API Cloudflare | secret d'environnement GitHub `CLOUDFLARE_API_TOKEN` | propriétaire du compte Cloudflare | aucun sur la boutique |
| Clé Stripe (`stripe_secret_key`) | coffre chiffré en D1 | commerçant (tableau de bord Stripe) | aucun si la nouvelle est saisie aussitôt |
| Secret de webhook Stripe | coffre chiffré | commerçant (endpoint Stripe → « Roll secret ») | les webhooks échouent tant que le nouveau n'est pas saisi |
| Clé Resend | coffre chiffré | commerçant | les e-mails échouent tant que la nouvelle n'est pas saisie |
| Clé secrète Turnstile | coffre chiffré | commerçant | les formulaires protégés refusent tant qu'elle n'est pas saisie |
| `AUTH_SECRET` | secret du Worker | opérateur | toutes les sessions tombent, rien d'autre |
| `SECRETS_KEK` | secret du Worker | opérateur | **le coffre devient illisible** : voir plus bas |
| Clé de sauvegarde | `.shopctl/backup.key`, secret GitHub `SHOPCTL_BACKUP_KEY` | opérateur | voir plus bas |
| Mot de passe admin | haché en D1 | commerçant | les sessions admin tombent |

## 2. Révoquer et remplacer

- **Jeton Cloudflare** : le révoquer dans le tableau de bord, en créer un
  nouveau de même portée, puis `CLOUDFLARE_API_TOKEN_<ENV>=… npm run shopctl --
  repo` réécrit les secrets GitHub (la commande les réécrit toujours).
- **Clés du coffre** (Stripe, Resend, Turnstile) : générer la nouvelle chez le
  fournisseur, la saisir dans Admin → Réglages, puis révoquer l'ancienne. Pour
  Stripe, préférer une clé restreinte et utiliser l'expiration différée que
  propose Stripe si un déploiement doit d'abord passer.
- **`AUTH_SECRET`** :
  `openssl rand -base64 32 | npx wrangler secret put AUTH_SECRET --name minshop-<slug>-<env>`
  (par l'entrée standard, jamais en argument).
- **`SECRETS_KEK`** : sa fuite n'expose les clés du coffre que si la base a
  fuité aussi, mais il faut le traiter comme si. Ordre : révoquer chez chaque
  fournisseur les clés que le coffre contient ; poser un nouveau
  `SECRETS_KEK` comme ci-dessus ; ressaisir chaque clé dans Admin → Réglages.
  Les anciennes valeurs chiffrées deviennent illisibles, ce qui est voulu.
- **Clé de sauvegarde** : elle ouvre toutes les archives prises avec elle. En
  écrire une nouvelle ailleurs (`backup keygen --key-file .shopctl/backup-2.key`),
  la mettre à la place de l'ancienne, supprimer le secret GitHub
  `SHOPCTL_BACKUP_KEY` puis relancer `shopctl repo` (le secret n'est posé que
  s'il est absent). Les archives existantes restent fermées par l'ancienne :
  la garder le temps que la rétention (90 jours) les emporte, ou les supprimer
  si l'ancienne clé est réputée connue d'un tiers.

## 3. Mesurer l'exposition

- Cloudflare : journal d'audit du compte, sur la période d'exposition ;
- Stripe : journal des requêtes API et des événements ;
- GitHub : journal d'audit de l'organisation, alertes de scan de secrets ;
- dépôt : `npm run check:secrets` sur l'arbre, et une recherche dans
  l'historique.

Si une donnée personnelle a pu être lue (base, archive et clé, coffre et
`SECRETS_KEK`), c'est aussi une [violation de données](violation-de-donnees.md).

## 4. Après

- la cause devient une règle : un motif ajouté à `scripts/check-secrets.mjs`
  si le secret avait une forme reconnaissable ;
- une note datée dans le registre d'incidents : quel secret, exposé où, de
  quand à quand, révoqué à quelle heure.
