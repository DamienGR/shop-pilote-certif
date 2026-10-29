# Compte mutualisé — essai réel de Cloudflare for SaaS (lot 3 de l'ADR 0019)

Fiche de passage pour le poste de Damien, sur son feu vert du 2026-10-28.
**Passée le soir même : essai vert** (§4). L'[ADR 0019](../architecture/decisions/0019-compte-cloudflare-mutualise.md)
demande qu'« une route par nom d'hôte vers des Workers distincts » soit prouvée
par un essai réel avant qu'une boutique n'en dépende : c'est cet essai. Il
précède le lot 8, la migration de `pilote-certif` vers le compte mutualisé.
Travail d'après le pilote (plan §13.1), hors des jalons 0 à 10.

Ce que l'essai prouve, avec le code qu'emprunte une boutique
(`shopctl/src/saas.mjs` et la route que rend `scripts/manifest.mjs`), par le
script `scripts/saas-trial.mjs` :

1. deux noms d'hôte personnalisés d'une même zone SaaS, servis chacun par **son**
   Worker, le chemin transmis tel quel ;
2. leur certificat émis par **validation HTTP**, sans autre geste que le CNAME ;
3. un CNAME posé dans une zone Cloudflare **d'un autre compte**, en DNS seul
   (miijot.fr, sur B) : c'est le cas du pilote pendant le lot 8 et celui de la
   sortie d'un client ;
4. un nom de la zone **sans route** (l'origine de repli elle-même) n'atteint
   aucun Worker, et `workers.dev` reste fermé.

Le script est répété en doublure par `test/scripts/saas-trial.test.mjs`, dans
`npm run verify` : la doublure de l'API du dépôt
(`test/fixtures/cloudflare-api-double.mjs`), un wrangler qui consigne ce qu'il
déploierait, et un réseau qui route chaque nom d'après les routes déployées et
y exécute le Worker téléversé. Elle couvre la création idempotente, l'attente
du DNS (code 4), l'essai vert, un Worker inversé (code 6) et le nettoyage
rejoué ; le Worker d'essai a aussi tourné sous le vrai wrangler
(`deploy --dry-run`, `dev`) le 2026-10-28. Elle ne peut pas répondre à ce que
l'essai demande : que Cloudflare route un nom d'hôte personnalisé par une
route de la zone SaaS, et en émette le certificat.

Pour la rejouer sur le poste, sans aucun compte :
`npx vitest run test/scripts/saas-trial.test.mjs`.

## Ce que l'essai crée, et ce qu'il ne touche pas

| Où | Ce qui est créé |
|---|---|
| Compte mutualisé (neuf) | le compte, sa zone SaaS, l'enregistrement `fallback`, l'origine de repli, le jeton de déploiement ; deux Workers `minshop-essai-a` et `minshop-essai-b` sans base, bucket, cron ni secret ; deux noms d'hôte personnalisés |
| Compte B | deux CNAME `essai-a` et `essai-b` dans la zone miijot.fr, en DNS seul |

Rien d'autre : la production du pilote (`certif-minshop.miijot.fr`, sur B) et
le compte A ne sont pas touchés. Coût : 0 € (Workers Free ; Cloudflare for SaaS
inclut 100 noms d'hôte), plus le domaine de la zone SaaS s'il faut l'acheter.
Le compte, la zone, l'origine de repli et le jeton restent : ce sont ceux du
lot 8 et des boutiques suivantes.

## 1. Dans le tableau de bord, une fois pour toutes

1. **Le compte mutualisé.** Une inscription neuve avec une adresse dédiée de
   l'agence, comme B à l'étape 2. Sur cet utilisateur, le seul Super
   Administrator du compte : une clé de sécurité matérielle. Personne d'autre
   n'est membre, aucun commerçant : tout passe ensuite par des jetons. Plan
   Workers Free (« Free d'abord, Paid au signal »). Ouvrir **Workers & Pages**
   une fois (le sous-domaine workers.dev, sans lequel le cron d'une boutique est
   refusé) et activer **R2** : l'essai n'en a pas besoin, le lot 8 si. Relever
   l'identifiant du compte (premier segment de l'URL du tableau de bord).
2. **La zone SaaS.** Un domaine de l'agence réservé à cet usage. Il
   n'apparaît jamais aux visiteurs, seulement en cible des CNAME des
   commerçants, mais il est dans chacun d'eux : en changer plus tard fait
   changer leur CNAME à tous. Pas studiomaestro.fr, qui est sur A et ne peut pas
   être sur deux comptes. Le plus simple : l'acheter par Cloudflare Registrar
   depuis le compte mutualisé, la zone y naît active. Sinon, un domaine déjà
   servi ailleurs passe dans cet ordre, sans coupure (dg-tech.dev le
   2026-10-28, depuis OVH) :
   - exporter sa zone chez l'hébergeur DNS actuel (OVH : Zone DNS → Modifier en
     mode textuel) : c'est la référence ;
   - si DNSSEC est actif (`dig +short DS <zone>` répond), le couper chez le
     registrar, puis attendre que le DS ait quitté le registre et la durée de
     vie du DS en plus (30 min pour .dev). Changer les serveurs de noms avant
     coupe le domaine entier, site et e-mail, pour tout résolveur qui valide ;
   - Add a domain → Free, chaque A, AAAA et CNAME importé en **DNS only** ;
   - comparer l'import à l'export, nom par nom : l'analyse rapide ne trouve que
     les noms qu'elle devine (elle avait manqué `strates`, un CNAME vers
     Netlify) ;
   - changer les serveurs de noms chez le registrar, puis attendre « Active ».
     Laisser l'ancienne zone intacte deux jours : le registre garde l'ancienne
     délégation en cache jusqu'à trois heures.
3. **L'origine de repli.** Dans la zone SaaS, DNS → Add record : type `AAAA`,
   nom `fallback`, contenu `100::`, **Proxied** (nuage orange). Puis SSL/TLS →
   Custom Hostnames → activer Cloudflare for SaaS (le tableau de bord peut
   demander un moyen de paiement, comme pour R2) → Fallback Origin :
   `fallback.<zone SaaS>` → attendre « Active ».
4. **Le jeton de déploiement du compte.** Mon profil → API Tokens → Create
   Token, modèle « Edit Cloudflare Workers », puis compléter jusqu'à :
   - compte : Workers Scripts, D1, Workers R2 Storage, Workers KV Storage en
     écriture ; Account Settings et Account Analytics en lecture ;
   - zone : Workers Routes en écriture, Zone en lecture, **SSL and Certificates**
     en écriture ;
   - utilisateur : Memberships et User Details en lecture ;
   - *Account Resources* : le compte mutualisé seul ; *Zone Resources* : la
     zone SaaS seule.

   C'est le jeton de production du dépôt de flotte (lot 8) : le créer une fois,
   le garder dans le gestionnaire de mots de passe, ne le coller nulle part
   ailleurs que dans la commande `read -rs` ci-dessous.
5. **Sur B, dans la zone miijot.fr** : deux CNAME, `essai-a` et `essai-b`, vers
   `fallback.<zone SaaS>`, **DNS only** (nuage gris). Avant ou après la
   section 2, indifféremment.

## 2. L'essai, depuis le poste (un quart d'heure)

Depuis la racine du clone de `minshop-platform`, à jour de `main`, sous
Node 22 (≥ 22.23.4) :

```sh
cd <clone de minshop-platform>
git switch main && git pull && npm ci
read -rs CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN   # le jeton du §1.4, collé sans écho
export CLOUDFLARE_ACCOUNT_ID=<id du compte mutualisé>
node scripts/saas-trial.mjs prepare --zone <zone SaaS> --domain miijot.fr
node scripts/saas-trial.mjs verify --zone <zone SaaS> --domain miijot.fr
```

`prepare` crée les deux noms d'hôte, déploie les deux Workers avec leur
route, et rappelle les deux CNAME. Il se relance sans dommage. `verify`
répond « en attente » (code 4) tant qu'un nom d'hôte ou son certificat n'est
pas actif : le relancer toutes les quelques minutes. Puis il lit chaque nom en
HTTPS, comme un visiteur, et finit par « Essai vert » (code 0) ou « Essai
rouge » (code 6).

Ce qu'un rouge voudrait dire :

- **`wrangler deploy` refuse la route** (code 5) : la route d'un nom d'hôte
  personnalisé ne se pose pas comme le rend le socle. Le repli de l'ADR est
  alors la zone du commerçant sur le compte mutualisé ;
- **un nom répond par l'autre Worker, ou le nom sans route atteint un Worker**
  (code 6) : le routage par nom d'hôte ne sépare pas les boutiques. Rien
  ne part en production sur ce modèle ;
- **un nom reste « pending » plus de trente minutes** : les erreurs que
  `verify` affiche sous lui le disent. Le plus souvent, le CNAME manque ou
  vise un autre nom que l'origine de repli, ou un enregistrement CAA de
  miijot.fr exclut les autorités de certification de Cloudflare.

Dans tous les cas, la sortie de `verify` se transmet telle quelle : elle ne
porte que des noms, des statuts et des identifiants, aucun secret.

## 3. Après l'essai

```sh
node scripts/saas-trial.mjs clean --zone <zone SaaS> --domain miijot.fr
```

supprime les deux Workers puis les deux noms d'hôte. Restent à la main les deux
CNAME de miijot.fr sur B, dont la suppression se vérifie hors du tableau de
bord : `dig essai-a.miijot.fr` doit répondre `NXDOMAIN`. Le résultat entre dans
l'ADR 0019 (Vérification), le plan §13.1 et les notes de version, par une pull
request du socle.

## 4. Résultat du 2026-10-28

**Essai vert**, à 22 h 56 UTC, sur le compte mutualisé (`305a2bac…`), zone SaaS
dg-tech.dev. Les quatre points ci-dessus tiennent :

```
$ node scripts/saas-trial.mjs verify --zone dg-tech.dev --domain miijot.fr; echo "code $?"
Compte 305a2bac…, zone SaaS dg-tech.dev (a58e7a67…), origine de repli fallback.dg-tech.dev : active.
  ✓ essai-a.miijot.fr — nom d'hôte active, certificat active (créé il y a 4 min)
  ✓ essai-b.miijot.fr — nom d'hôte active, certificat active (créé il y a 4 min)
  ✓ essai-a.miijot.fr — HTTP 200 en HTTPS, servi par minshop-essai-a, chemin transmis (cf-ray a51d88428f925fcb-CDG)
  ✓ essai-b.miijot.fr — HTTP 200 en HTTPS, servi par minshop-essai-b, chemin transmis (cf-ray a51d88435a313cbd-CDG)
  ✓ fallback.dg-tech.dev — sans route, n'atteint aucun Worker (HTTP 522)
  ✓ minshop-essai-a.<sous-domaine>.workers.dev — fermé (HTTP 404)
  ✓ minshop-essai-b.<sous-domaine>.workers.dev — fermé (HTTP 404)

Essai vert (2026-10-28T22:56:11.986Z) : chaque nom d'hôte mène à son Worker, en HTTPS, et rien d'autre n'y mène.
code 0
```

- `prepare` (code 0) : `wrangler deploy` a accepté la route `essai-a.miijot.fr/*`
  posée sur la zone dg-tech.dev, telle que la rend le socle.
- Lus de l'extérieur à 22 h 55 UTC, certificat vérifié : chaque nom renvoyait son
  Worker. Certificats émis par « Cloudflare TLS Issuing ECC CA 4 » (SSL.com),
  un nom par certificat, valables jusqu'au 2027-01-26.
- `clean` a supprimé les Workers et les noms d'hôte : les deux noms ont répondu
  `error code: 1014` (CNAME vers la zone d'un autre compte, sans nom d'hôte qui
  l'accueille) tant que leurs CNAME restaient sur B, puis `NXDOMAIN`.

Deux écarts à la fiche, acceptés pour l'essai, à lever ou à assumer avant le
lot 8 :

- **la double authentification** de l'utilisateur du compte est une
  application (TOTP), pas une clé matérielle (§1.1) : une clé est à poser avant
  que le compte ne porte une production ;
- **dg-tech.dev n'est pas réservé à cet usage** (§1.2) : il porte aussi le site
  de l'agence (Netlify, en DNS only) et ses redirections d'e-mail (MX d'OVH).
  Ce DNS vit désormais dans le compte des boutiques. L'adresse de connexion du
  compte est elle-même en @dg-tech.dev : ses codes de secours, rangés hors de
  cette adresse, sont ce qui rouvre le compte si la zone tombe.

La migration de dg-tech.dev depuis OVH a suivi l'ordre du §1.2 ; le site, ses
sous-domaines et les e-mails ont répondu à l'identique avant et après la
bascule (registre .dev à 23 h 43, zone active à 23 h 45, heure de Paris).
Sortie complète et certificats archivés hors dépôt
(`~/certif-archives/essai-saas/`).

## Ce qui suit : le lot 8

La migration du pilote suit la [sortie client, §1 bis](../operations/sortie-client.md)
à l'envers ; sa fiche, répétée en doublure le 2026-10-28, est
[compte-mutualise-migration-pilote.md](compte-mutualise-migration-pilote.md).
Les quatre points qu'elle prépare :

- **le dépôt de flotte** : un dépôt GitHub de l'agence, public (GitHub Free
  n'a de secrets d'environnement que sur un dépôt public), créé par
  `shopctl fleet init` puis `fleet repo`. Il porte les jetons du compte, la clé
  de sauvegarde, et deux autres jetons à créer comme au §1.4 : la sauvegarde
  nocturne et la lecture pour `monitor` (droits : [comptes et accès,
  §4](comptes-et-acces.md)) ;
- **le domaine d'images du pilote** (`images-certif-minshop.miijot.fr`) ne peut
  pas suivre : le domaine personnalisé d'un bucket R2 doit être dans une zone du
  compte du bucket. Soit les images passent par le Worker (aucun domaine, mais
  des requêtes de plus sur le quota quotidien partagé du plan Free), soit un nom
  de la zone SaaS (`images-certif-minshop.<zone SaaS>`), que la fiche du
  lot 8 retiendra ;
- **un widget Turnstile** sur le compte mutualisé, pour le lot de dix noms
  d'hôte dont `certif-minshop.miijot.fr` sera le premier ;
- **une clé de sécurité matérielle** sur l'utilisateur du compte mutualisé,
  l'écart du §4.
