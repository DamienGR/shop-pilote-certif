# Étape 11 — Validations humaines et décision : la fiche (jalon 10)

Fiche de passage pour Damien. Elle suit l'étape 11 du
[plan](plan.md#étape-11--validations-humaines-et-décision) : les pages légales
et le consentement aux CGV relus, la TVA et la facturation validées par un
expert-comptable, une recette par une personne extérieure au développement, la
documentation du §12 complète, les rapports assemblés et les dérogations
signées, puis la décision go/no-go (point F).

À la différence des étapes 3 à 10, presque rien ici n'est une commande : ce
sont des personnes qui valident. La fiche dit ce qu'il faut leur remettre, ce
qu'il faut obtenir d'elles, et où la preuve se range. Le
[dossier de décision](dossier-de-decision.md) assemble les rapports, l'état de
chaque critère du §8, les dérogations à signer et la fiche de décision.

Préparée le 2026-10-25, contre la production du pilote en `v0.3.24` et ses
preuves des étapes 2 à 10.

## Ce que la préparation a trouvé

Corrigé dans `v0.3.25` (`docs/migrations/v0.3.25.md`) :

1. **Les quatre pages légales de la production sont publiées en squelette.**
   Relevé sur la vitrine le 2026-10-25 : quatorze lignes des CGV portent
   « [À COMPLÉTER] » ou le bandeau « Brouillon », neuf des mentions légales,
   cinq de la politique de confidentialité, quatre de la rétractation. La commande
   réelle `tspzkyxggc` de l'étape 10 a accepté ces CGV, « version 1 », qui ne
   nomment pas le vendeur. L'étape 4 les publiait exprès sur le staging, leur
   relecture étant celle-ci ; rien n'empêchait de les publier aussi en
   production. Depuis `v0.3.25`, une production refuse de publier une page qui
   porte un marqueur, et le dit à chaque enregistrement d'une page en ligne
   qui en porte encore.
2. **Le nocturne du pilote est rouge depuis le 2026-10-24**, sur l'audit des
   dépendances : `undici` (via `miniflare` et `unifont`) et `zod` (via Astro),
   deux alertes élevées publiées après `v0.3.24`. La sauvegarde de la
   production et sa surveillance, deux jobs à part, sont vertes les deux nuits.
   Le §8.4 demande « aucune vulnérabilité critique ou élevée non justifiée » :
   `v0.3.25` monte les deux paquets.
3. **Les traces étaient gardées à 100 %.** Dès le 2026-12-01, Cloudflare les
   compte avec les journaux dans une même allocation d'ingestion ; au plan
   gratuit, il cesse d'ingérer à 0,5 Go par jour, journaux compris. Une
   requête sur dix en `v0.3.25`.

Vérifié, sans écart : le nom de la boutique est « Certif Minshop » en
production (titre, `llms.txt`) et `client.displayName` le porte, le point « Ma
boutique » de l'étape 7 est clos ; `v0.3.21` à `v0.3.24` sont publiées (le
2026-10-23 pour la première, le 2026-10-25 pour la dernière).

Hors des lignes du plan, trois questions que la décision doit trancher, posées
dans le [dossier](dossier-de-decision.md#5-décisions-à-prendre-avant-le-gono-go) :
le CPU (rapport de performance), le RPO tenu « une archive par nuit » mais pas
à la minute, et la ligne « échec réseau temporaire » du §8.7, qu'aucune étape
de la campagne n'a rejouée.

## Ce que l'étape crée, et ce qu'elle ne touche pas

| Où | Ce qui est créé, modifié ou détruit |
|---|---|
| Cloudflare B | la production redéployée en `v0.3.26`, puis avec `termsVersion` à 2 ; les quatre pages légales réécrites dans sa base ; pour la recette, un produit de recette, et une commande avec son remboursement si elle paie en réel |
| Stripe live | seulement si la recette paie en réel : une clé restreinte créée puis supprimée, un code promotionnel, un paiement de quelques euros remboursé, ses frais (de l'ordre de 0,30 €) |
| Resend | les e-mails de la recette |
| GitHub `minshop-platform` | les pull requests de `v0.3.25` et `v0.3.26`, un run `Release` |
| GitHub `shop-pilote-certif` | la pull request `socle/v0.3.26`, celle de `termsVersion`, deux runs `Deploy` approuvés, la pull request des preuves |
| Hors des comptes | les textes relus par un conseil, l'avis écrit d'un expert-comptable, le procès-verbal de recette signé, le dossier de décision signé |
| Cloudflare A, `canari-certif`, Stripe test | rien |

**Rien de ce qui est signé ne va dans un dépôt public.** Les dépôts du pilote
le sont (étape 1) : un nom de relecteur, une signature ou l'adresse d'un
testeur y seraient publiés pour toujours. Les originaux signés restent chez
Damien ; les preuves du dépôt en donnent la date, la qualité de la personne
(« avocat », « expert-comptable inscrit à l'Ordre », « testeur extérieur ») et
les conclusions.

## 0. Shell propre

Prérequis : les pull requests de `v0.3.25` et `v0.3.26` fusionnées sur le socle.

```sh
P=<chemin>/shop-pilote-certif
git -C "$P" switch main && git -C "$P" pull && git -C "$P" status --short     # rien
cd "$P" && nvm install 22
gh repo set-default DamienGR/shop-pilote-certif
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
COMPTE_B=$(awk '/^  productionAccountId:/ {print $2}' client/client.yaml)
export PROD="https://$(awk '/^  productionDomain:/ {print $2}' client/client.yaml)"
E="$P/client/certification/etape-11" && mkdir -p "$E"
# Lectures de la base de production. Jamais email ni ship_address : les preuves vont dans un dépôt public.
q() { CLOUDFLARE_ACCOUNT_ID=$COMPTE_B npx wrangler d1 execute minshop-pilote-certif-production-db --remote --json --command "$1"; }
LEGALES="conditions-generales-de-vente mentions-legales politique-de-confidentialite droit-de-retractation"
# Par page : le code HTTP, puis le nombre de lignes qui portent un marqueur ou le bandeau.
marqueurs() {
  for s in $LEGALES; do
    r=$(curl -s -w '\n%{http_code}' "$PROD/pages/$s")
    printf '%s %s %s\n' "$s" "$(tail -n1 <<<"$r")" "$(grep -c 'COMPLÉTER\|Brouillon' <<<"$r")"
  done
}
marqueurs | tee "$E/pages-avant.txt"     # 200 partout ; 14, 9, 5, 4 : l'état relevé le 2026-10-25
```

## 1. Publier `v0.3.26` et monter le pilote

`v0.3.25` n'a pas de tag : `v0.3.26` (Node 22.23.4, Astro 7.4) a été fusionnée
avant sa publication. Elle porte donc les corrections de `v0.3.25`, et la pull
request de montée reprend les deux notes de migration. Le poste a besoin de
Node 22.23.4 : c'est le `nvm install 22` de la section 0.

Sur le socle : GitHub → Actions → **Release** → Run workflow, version
`0.3.26`. Puis dans le pilote, comme à l'étape 10 :

```sh
npm run shopctl -- core upgrade --to v0.3.26 --open-pr
gh pr checks socle/v0.3.26 --watch
gh pr merge socle/v0.3.26 --merge
git switch main && git pull && npm ci && npm ci --prefix mcp
npm run shopctl -- core status                       # v0.3.26
gh workflow run deploy.yml -f shop=pilote-certif -f environment=production
sleep 10 && R=$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId') && echo "$R"
```

GitHub → Actions → ce run → **Review deployments** → `production` →
**Approve and deploy**.

```sh
gh run watch "$R"; echo $?
gh run download "$R" -D "$E/deploy-v0.3.26"
gh workflow run nightly.yml && sleep 10
N=$(gh run list --workflow nightly.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$N"; echo $?
gh run view "$N" > "$E/nocturne.txt"
```

Attendu : la pull request verte ; le déploiement vert, archive préalable
comprise ; le nocturne vert, `Dependency audit` compris. Puis, dans Admin →
Pages, enregistrer la page des CGV sans la modifier : l'avertissement dit
qu'elle est en ligne et porte encore « [À COMPLÉTER] ». C'est le refus de
`v0.3.25` vu en réel.

## 2. Les pages légales et le consentement aux CGV

La boutique ne prend aucune commande en ce moment (clés live retirées à
l'étape 10) : les textes et leur version peuvent changer sans qu'aucun achat
ne tombe entre les deux.

**Rédiger.** Les quatre squelettes disent ce qu'il manque, marqueur par
marqueur. Pour le pilote, le vendeur est celui qui a encaissé la commande
réelle de l'étape 10 : Damien, sous la forme juridique qui est la sienne.

- **CGV** : identité du vendeur, prix TTC et frais de livraison, commande et
  paiement, livraison et délais, droit de rétractation, garanties légales,
  réclamations et médiateur de la consommation ;
- **mentions légales** : éditeur, directeur de la publication, hébergeur (nom,
  adresse, téléphone : Cloudflare, à relever sur ses conditions) ;
- **politique de confidentialité** : responsable, finalités, durées (une
  commande payée est gardée dix ans, `docs/agents/privacy.md`), destinataires
  — la liste de [sous-traitants.md](../operations/sous-traitants.md) —, droits
  et contact ;
- **droit de rétractation** : l'adresse où l'exercer et le formulaire type.

**Faire relire** par un conseil compétent (avocat, ou juriste d'une chambre de
commerce), avec les quatre textes et ces points du parcours, qu'il voit sur
la boutique :

- la case du panier : « J'ai lu et j'accepte les conditions générales de
  vente », le lien vers la page, et le refus du serveur sans elle ;
- l'enregistrement : la version acceptée et l'heure, sur chaque commande et
  dans l'export ;
- le bouton qui engage le paiement : « Payer par carte » dans le panier, puis
  « Payer » sur la page de Stripe (article L221-14 du code de la
  consommation) ;
- l'e-mail de confirmation, qui sert de récapitulatif de commande.

**Monter la version des CGV**, dans `src/store.config.ts` du pilote : la
commande de l'étape 10 a accepté la « version 1 », le squelette ; le texte
relu est la 2.

```ts
export const storeOverrides: DeepPartial<SiteConfig> = {
  legal: { termsVersion: '2' },
};
```

```sh
git switch -c cgv-version-2
git commit -am "CGV : version 2, le texte relu (certification, étape 11)"
git push -u origin cgv-version-2 && gh pr create --fill
gh pr checks cgv-version-2 --watch && gh pr merge cgv-version-2 --merge
git switch main && git pull
gh workflow run deploy.yml -f shop=pilote-certif -f environment=production
```

Approuver le run comme en section 1. Puis **saisir** chaque texte dans Admin
→ Pages, bandeau « Brouillon » retiré, et enregistrer : un marqueur oublié est
signalé.

```sh
marqueurs | tee "$E/pages-apres.txt"     # 200 et 0 partout
q "SELECT slug, published, updated_at, body_markdown FROM pages WHERE slug IN ('conditions-generales-de-vente','mentions-legales','politique-de-confidentialite','droit-de-retractation')" > "$E/pages.json"
```

Attendu : quatre zéros ; dans le panier, la case qui renvoie aux nouvelles
CGV et « Version 2 ».

## 3. La TVA et la facturation : l'expert-comptable

Le manifeste porte `invoiceStrategy: pending-validation`, et l'ADR 0010 le dit
nettement : tant que la validation n'est pas obtenue, aucune boutique ne passe
en production pour vendre. Lui remettre :

- l'[ADR 0010](../architecture/decisions/0010-tva-facturation-et-consentement.md),
  ou son résumé : prix TTC, un taux par boutique, la TVA tirée du total payé et
  arrondie une fois, frais de port et remise compris, un reçu et pas de
  facture numérotée ;
- l'e-mail de confirmation et celui du remboursement de `tspzkyxggc`
  (6,90 €, dont 1,15 € de TVA), depuis la boîte Gmail ;
- l'export CSV des commandes (Admin → Commandes → Exporter en CSV), réduit à
  cette commande.

Et lui poser ces questions, dont les réponses écrites sont la preuve :

1. pour une vente à un particulier, le reçu de la boutique suffit-il, ou
   faut-il une facture numérotée, toujours ou à la demande du client ?
2. la TVA calculée une fois sur le total, frais de port au même taux et
   remise déduite, convient-elle ?
3. un remboursement demande-t-il un avoir, ou l'export suffit-il ?
4. l'export contient-il ce qu'il faut pour tenir la comptabilité et déclarer
   la TVA ?
5. pour le pilote, quel est le régime du vendeur ? Un vendeur en franchise en
   base ne facture pas de TVA et l'écrit (« TVA non applicable, art. 293 B du
   CGI ») : le socle ne connaît que 20, 10, 5,5 et 2,1 %, et cette boutique
   afficherait une TVA qui n'est pas due.

Ce que la réponse décide :

- **le reçu de la boutique suffit** : aucune valeur de `invoiceStrategy` ne le
  dit aujourd'hui (`stripe-receipt` désigne le reçu de Stripe, que l'étape 10
  a coupé) ; une valeur à ajouter au schéma du manifeste, dans le socle ;
- **le reçu de Stripe** : `stripe-receipt`, et « Paiements réussis » activé
  dans Stripe (Paramètres → Entreprise → E-mails aux clients) ;
- **une facture numérotée** : `invoice`, un livrable qui n'existe pas
  (ADR 0010, Conséquences). La commercialisation attend qu'il soit construit,
  ou la décision le pose en condition ;
- **la franchise en base** : un taux nul et sa mention, à ajouter au socle
  avant de vendre pour ce vendeur.

## 4. La recette par une personne extérieure

Une personne qui n'a ni développé ni exploité la boutique, avec
[recette.md](../operations/recette.md) seul. Le moyen de payer est le choix du
commerçant :

- **en production, paiement réel** (recommandé) : l'interface livrée, telle
  qu'elle est. Les clés live remises le temps de la séance, comme aux
  sections 3 et 10 de la [fiche de l'étape 10](etape-10-commandes.md), un
  produit de recette à 1 € et un code promotionnel créés avant, la commande
  remboursée par la personne elle-même (scénario A4), les clés retirées
  après. Frais : ceux d'un paiement, que le remboursement ne rend pas ;
- **sur un staging recréé sur A**, Stripe en mode test : aucun frais, mais un
  staging à provisionner, à remplir et à détruire, derrière Access, qui n'est
  pas l'interface livrée ;
- **en production, sans payer** : jusqu'à la page de Stripe, puis
  l'administration. Rien n'est encaissé, et les scénarios V9, V10, A2 à A5
  restent « sans objet ».

L'administration n'a qu'un mot de passe : Damien se connecte devant la
personne, ou le lui confie pour la séance et le change ensuite
(`npm run shopctl -- admin password --env production`).

```sh
q "SELECT public_id, status, amount_total_cents, refunded_cents, terms_version FROM orders ORDER BY id DESC LIMIT 3" > "$E/recette-commandes.json"
```

Attendu : le procès-verbal signé, aucune anomalie bloquante. Une anomalie du
socle se corrige dans le socle et devient un test, comme aux étapes
précédentes ; la recette se rejoue sur le scénario concerné.

## 5. La documentation du §12

Le [dossier](dossier-de-decision.md#4-documentation-du-12) range les
quatorze documents que le §12 exige, chacun avec son fichier. Quatre ont été
écrits pour cette étape : la [recette](../operations/recette.md), le
[remboursement](../operations/remboursement.md), les
[responsabilités](../operations/responsabilites.md) et les
[sous-traitants](../operations/sous-traitants.md). À relire comme un
commerçant les lirait.

## 6. Rapports, dérogations, décision

Dans le [dossier de décision](dossier-de-decision.md) :

- relire l'état de chaque critère du §8 (section 2) ;
- trancher les trois questions de la section 5 ;
- signer les dérogations de la section 3, sur l'exemplaire gardé hors du
  dépôt ;
- remplir la décision de la section 6.

Passée le 2026-10-27 sans exemplaire signé : Damien a accepté les
dérogations et décidé par écrit, dans la session de l'agent. Le critère de
sortie demande une dérogation écrite et datée, et le dossier la porte.

## 7. Les preuves

```sh
grep -rl "$HOME" "$E" | xargs -r sed -i "s|$HOME|~|g"
grep -rc "$HOME" "$E" | grep -v ':0$'                # rien
grep -lE '@|ship_address' "$E"/*.json "$E"/*.txt     # rien
git status --short                                   # client/certification seulement
git switch -c certification-etape-11
git add client/certification && git commit -m "Certification, étape 11 : validations humaines"
git push -u origin certification-etape-11
gh pr create --fill
```

Dans `client/certification/etape-11/README.md`, ce qui ne laisse pas de
fichier : la date et la qualité du relecteur des pages légales et ses
remarques, la réponse de l'expert-comptable (date, qualité, conclusions), la
date de la recette, la qualité de la personne, ses résultats et ses
anomalies, les décisions de la section 5 du dossier, et la décision go/no-go.

## Ce qui coche le plan

| Ligne du plan | Preuve | Attendu |
|---|---|---|
| relecture des pages légales et du consentement aux CGV | `pages-avant.txt`, `pages-apres.txt`, `pages.json`, README | quatre pages sans marqueur, relues par un conseil, CGV en version 2 |
| validation TVA et facturation par un expert-comptable | README, et `invoiceStrategy` dans le manifeste | une réponse écrite et datée ; `invoiceStrategy` qui en dit le résultat |
| recette par une personne extérieure | README, `recette-commandes.json` | le procès-verbal signé, hors du dépôt ; aucune anomalie bloquante |
| documentation du §12 complète | le dossier, section 4 | chaque document présent et relu |
| rapports assemblés, dérogations signées | le dossier, sections 2 et 3 | chaque critère du §8 tenu ou sous dérogation signée |
| décision go/no-go (point F) | le dossier, section 6 | la décision, datée et signée |

## Ce qui ferme l'étape

La pull request des preuves du pilote verte, et le dossier de décision rempli.
Les donner dans le thread : le plan est coché, le jalon 10 et le point de
décision F avec lui.
