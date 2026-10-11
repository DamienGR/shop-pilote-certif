# Étape 2 — Forge réelle (pilote-certif)

Plan de certification du socle, étape 2, passée le 2026-10-11 sur le socle
`v0.3.1`.

| Preuve | Ce qu'elle montre |
|---|---|
| `repo-1.json` | `shopctl repo --public --reviewer DamienGR` : dépôt public, `staging` et `production`, relecteur obligatoire sur `production`, secrets de `staging` posés depuis `CLOUDFLARE_API_TOKEN_STAGING` |
| `repo-2.json` | la même commande relancée : rien de créé, rien de poussé, secrets réécrits |

Relu sur GitHub après les deux passages :

- `DamienGR/shop-pilote-certif` public, `main` au même commit que l'arbre local ;
- `staging` : `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SHOPCTL_BACKUP_KEY` ;
- `production` : aucun secret, relecteur obligatoire `DamienGR` — le jeton du
  compte B vient à l'étape 9.

Le premier passage a échoué au push : `shopctl` lisait le protocole global de
`gh` (`https`) au lieu de celui de github.com (`ssh`) et posait un remote HTTPS.
`origin` a été remis en SSH à la main, puis la commande relancée. Corrigé dans
le socle après `v0.3.1`.
