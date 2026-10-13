# Étape 3 — staging sur le compte A

Preuves du passage réel, 2026-10-12 et 2026-10-13. Le plan et la fiche de
commandes sont dans le socle (`docs/certification/`).

| Ligne du plan | Preuve | Résultat |
|---|---|---|
| `provision` à blanc, réel, puis une seconde fois | `provision-1.json`, `provision-2.json` | quatre `create`, puis quatre `keep` |
| `provision` avec le mauvais compte | `provision-mauvais-compte.json` | refus, code 4 |
| juridiction `eu` lue via l'API | `provision-1.json` (`jurisdictionChecks`) | `eu` relue sur la base et les trois buckets |
| bucket de fichiers privé | `provision-1.json` (`exposure`) | `-files` et `-backups` sans URL publique ni domaine |
| `deploy --env staging` | `deploy.json` (v0.3.2, contournements), `deploy-v0.3.3.json` (sans contournement) | test de fumée vert, `/` en 302 vers Access ; `workers.dev` en 404 ; secrets conservés (`provision-3.json`) |
| `/admin/setup` derrière Access | — | mot de passe posé ; la réponse 500 de `v0.3.2` (purge d'un Worker sans cache) est corrigée en `v0.3.3` |
| le chemin du webhook, et lui seul, contourne Access | — | POST non signé sur `/api/webhook` : 400 « Missing stripe-signature header » ; `/` et `/admin` : 302 |
| `catalog import --remote` deux fois | `catalog-import-1.json`, `catalog-import-2.json` | 20 produits, 9 variantes, 4 catégories, 8 images ; puis `statements: 0` |
| clés Stripe test, Resend, Turnstile de test | — | saisies dans l'administration ; e-mail de test reçu |
| `Nightly` réactivé et lancé | [run 38455159960](https://github.com/DamienGR/shop-pilote-certif/actions/runs/38455159960), tentative 2 | voir ci-dessous |

## Le run `Nightly`

Vert : sauvegarde, restauration locale, porte de sécurité distante, session
Stripe test expirée et unité rendue par le webhook, e-mail de test, audit des
dépendances, suite complète, supervision de la production (sans jeton jusqu'à
l'étape 9).

Rouge, nommé plutôt que coché :

- **porte navigateur**, un contrôle sur quatre-vingts : l'image principale
  d'une fiche était cherchée sous la seule forme d'une galerie. Défaut du
  test, corrigé dans le socle (pull request #59), arrivera par la prochaine
  montée de version ;
- **CPU p99** : 36,97 ms pour un plafond de 10 ms au plan gratuit, sur
  308 invocations dont la plupart sont le cron. Mesuré par requête :
  administration 13 à 43 ms, connexion 35 ms, `GET /` 26 ms à froid, cron 1 à
  4 ms ; aucune invocation interrompue. Tranché à l'étape 6, en optimisant
  autant que possible.

Le tout premier passage était rouge sur la porte de sécurité, Stripe et
l'e-mail : le jeton de service Access était refusé (401 d'Access), réglé en
reposant les deux secrets.
