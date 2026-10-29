# Procédure — départ d'un client

Le commerçant qui quitte l'agence part avec sa boutique, en état de marche, et
l'agence ne garde rien de ses données. C'est la promesse de réversibilité de
l'ADR 0002. Stripe, Resend et le domaine sont déjà les siens ; ce qui décide du
reste, c'est le compte Cloudflare qui héberge la boutique :

- **sur le compte mutualisé de l'agence** (ADR 0019, toute boutique créée
  depuis v0.3.32) : le départ est une **migration** vers un compte Cloudflare
  du commerçant, la section 1 bis, puis les sections suivantes ;
- **sur le compte du commerçant** (le pilote avant sa migration) : il n'y a
  **rien à migrer**, seulement des accès à rendre et des copies à effacer.

Dans les deux cas, deux départs sont possibles, et le second contient le
premier :

- **il garde Cloudflare** et change seulement d'opérateur ;
- **il quitte aussi Cloudflare** : il emporte alors une sauvegarde lisible sans
  Cloudflare (ADR 0005) et la clé qui l'ouvre.

## 1. Avant de rendre les accès

- [ ] le dernier run nocturne est vert, et une sauvegarde fraîche est prise et
  vérifiée :
  `npm run shopctl -- backup --env production --upload` puis
  `npm run shopctl -- backup verify <id>` ;
- [ ] la boutique est à une version publiée du socle
  (`npm run shopctl -- core status`) : le repreneur doit pouvoir dire de quel
  tag il part ;
- [ ] les migrations en attente sont appliquées — aucune ne doit rester entre
  deux opérateurs.

## 1 bis. Quitter le compte mutualisé

Ni base, ni bucket, ni Worker ne se transfèrent d'un compte Cloudflare à un
autre (ADR 0015) : la boutique est sauvegardée, recréée sur le compte du
commerçant (B), restaurée, puis détruite sur le compte mutualisé. C'est la
restauration chronométrée de l'étape 8 de la certification (29 min 21 s vers
un compte neuf), suivie d'une bascule du domaine. Le chemin inverse, la
migration du pilote vers le compte mutualisé (plan §13.1, lot 8), a été répété
en doublure le 2026-10-28 ([sa fiche](../certification/compte-mutualise-migration-pilote.md)) :
les corrections qu'il a apportées sont reprises ici.

**Chez le commerçant, avant le jour J** — les prérequis de B de la
[mise en ligne, §0](mise-en-ligne.md#0-prérequis-sur-le-compte-du-client-b) :
compte, double authentification, R2 activé, Workers ouvert une fois, ses trois
jetons, un widget Turnstile. Puis **sa zone sur B**, en reprenant tels quels
les enregistrements de son DNS actuel, CNAME vers l'origine de repli compris,
avant de changer ses serveurs de noms : servi par B en DNS seul (nuage gris),
ce CNAME continue de mener au compte mutualisé (Cloudflare for SaaS accepte un
nom d'hôte dont la zone est elle-même chez Cloudflare), et la boutique ne
s'arrête pas.

**Le jour J**, depuis l'arbre de la boutique, au commit encore sur le compte
mutualisé, avec un jeton de ce compte :

- [ ] fermer les commandes : Admin → Réglages → Paiements, chaque moyen
  désactivé (le panier désactivé ne suffit pas : l'achat immédiat et l'API de
  commande passent sans lui). Puis attendre trente minutes, la durée d'une
  session de paiement Stripe ouverte avant la fermeture. Une commande payée
  après la sauvegarde ci-dessous serait perdue ;
- [ ] la dernière sauvegarde, rapatriée en entier et contrôlée avec la clé :
  ```sh
  npm run shopctl -- backup --env production --upload
  npm run shopctl -- backup pull <id> --env production
  npm run shopctl -- backup verify <id>
  ```
- [ ] un arbre de ce commit mis de côté pour la destruction finale, avec ses
  dépendances (shopctl y appelle le wrangler de l'arbre) :
  `git worktree add ../<slug>-mutualise HEAD && (cd ../<slug>-mutualise && npm ci)`.

Puis, par une pull request de la boutique : `cloudflare.accountId` = B,
`cloudflare.saasZone` retiré (le domaine redevient un domaine personnalisé du
Worker, sur la zone de B), et `cloudflare.imagesDomain`, s'il est posé, changé
pour un nom de la zone de B : le domaine personnalisé d'un bucket R2 est
toujours dans une zone du compte du bucket. Fusionnée, depuis l'arbre à jour et
avec les jetons de B :

```sh
npm run shopctl -- provision --env production
npm run shopctl -- restore --env production --from <id> --allow-production --confirm <slug>
```

Entre les deux, le domaine d'images attaché au bucket d'images de B (tableau de
bord → R2 → le bucket → Settings → Custom Domains) : `deploy` le refuse
absent.

La restauration remet les lignes, les images et le mot de passe
d'administration, pas le coffre : ses clés étaient scellées par le
`SECRETS_KEK` du Worker du compte mutualisé, et `restore` nomme celles qui ne
s'ouvrent plus. Ensuite :

- [ ] `gh variable delete MINSHOP_FLEET`, puis `npm run shopctl -- repo
  --reviewer <login>` avec les jetons de B : le dépôt retrouve ses
  environnements et ses workflows Deploy et Nightly ;
- [ ] dans le DNS de B, supprimer le CNAME du domaine vers l'origine de repli :
  la boutique ne répond plus jusqu'au déploiement qui suit ;
- [ ] `gh workflow run deploy.yml -f shop=<slug> -f environment=production`,
  approuvé : le domaine personnalisé sur la zone de B, le test de fumée ;
- [ ] Admin → Réglages, ressaisis : la clé Stripe restreinte et le secret de
  signature de l'endpoint (même URL, rien à changer chez Stripe), la clé
  Resend, les clés du widget Turnstile de B. Puis les moyens de paiement
  réactivés ;
- [ ] une commande réelle remboursée, comme à la recette.

**Sur le compte mutualisé, une fois B vérifié**, depuis l'arbre mis de côté et
avec un jeton du compte mutualisé : retirer le domaine d'images du bucket
d'images (Settings → Custom Domains), puis vider les buckets de la boutique, le
`-backups` compris (R2 refuse de supprimer un bucket qui porte des objets ;
tableau de bord → R2 → le bucket → Settings → Empty Bucket), puis

```sh
npm run shopctl -- destroy --env production --confirm <slug> --dry-run
npm run shopctl -- destroy --env production --confirm <slug> --yes
```

qui supprime le Worker, le nom d'hôte personnalisé de la zone SaaS, les buckets
et la base, dans cet ordre. Enfin, retirer la boutique du `fleet.json` du dépôt
de flotte par une pull request, et `git worktree remove ../<slug>-mutualise`.

## 2. Remettre

- [ ] **le dépôt** : transfert du dépôt GitHub de la boutique vers
  l'organisation du commerçant (Settings → Transfer), ou une copie complète
  avec son historique si l'agence doit garder l'original pour sa propre
  comptabilité. L'historique compte : c'est lui qui dit de quel tag du socle
  la boutique part et quelles divergences elle porte ;
- [ ] **la clé de sauvegarde**, par un canal chiffré et jamais avec une
  archive dans le même envoi. Le commerçant peut ensuite en écrire une nouvelle
  (`backup keygen`) et reprendre une sauvegarde sous sa clé ;
- [ ] **les secrets d'environnement GitHub** : `shopctl repo`, lancé par le
  repreneur avec ses propres jetons, réécrit `CLOUDFLARE_API_TOKEN` ;
  `SHOPCTL_BACKUP_KEY` se remplace en supprimant le secret puis en relançant.
  Une boutique venue du compte mutualisé n'en avait aucun : la section 1 bis
  les a posés avec les jetons de B ;
- [ ] **la documentation** : ce dossier `docs/operations/`, les ADR, le plan,
  et les dérogations écrites encore ouvertes.

S'il quitte aussi Cloudflare : une archive pleine (`backup` sans `--no-media`,
qui emporte les octets des images et des fichiers vendus), copiée hors du
bucket par `backup pull`, qui rapatrie aussi les médias que l'archive a
laissés dans le pool du bucket, et la clé. Le format est documenté par
`shopctl/src/backup/archive.mjs` : un manifeste en clair, un corps gzip puis
AES-256-GCM, un fichier par objet.

## 3. Révoquer les accès de l'agence

Le commerçant les retire lui-même, l'agence le lui demande et vérifie :

- [ ] Cloudflare : membres du compte, et jetons API créés pour l'agence (sur
  B, pour une boutique venue du compte mutualisé : ceux de la section 1 bis,
  si l'agence les a créés pour lui) ;
- [ ] Stripe : membres de l'équipe, clés restreintes créées pour l'agence ;
- [ ] Resend, registrar du domaine : membres ;
- [ ] GitHub : collaborateurs et équipes de l'agence sur le dépôt ;
- [ ] Cloudflare Access : les politiques qui nomment des adresses de
  l'agence.

## 4. Effacer ce que l'agence détient

L'article 28, paragraphe 3, point g) du RGPD : au terme du service, le
sous-traitant supprime ou renvoie les données personnelles, et en supprime les
copies.

- [ ] sur les postes des opérateurs : le répertoire `backups/` de l'arbre, les
  exports `privacy/`, `.shopctl/backup.key` une fois la clé remise ;
- [ ] tout environnement de la boutique encore présent sur un compte de
  l'agence : `shopctl destroy --env <env> --confirm <slug>` (ADR 0015 ; la
  production sur le compte mutualisé, section 1 bis ; un staging, normalement
  détruit à la mise en ligne). Les archives du bucket `-backups` y partent
  avec lui ; ailleurs, elles expirent seules en 90 jours, et les médias du
  pool en 180 ;
- [ ] les artefacts du workflow Deploy restent avec le dépôt transféré ; ils ne
  portent aucune donnée personnelle, seulement des rapports.

## 5. Clore

Un procès-verbal daté, signé des deux parties : la liste ci-dessus cochée,
l'identifiant de la dernière sauvegarde remise et son empreinte, la date de
révocation de chaque accès, et l'attestation de suppression des copies.
