# Compte mutualisé — la migration du pilote (lot 8)

Passée les 29 et 30 octobre 2026 selon la fiche
`docs/certification/compte-mutualise-migration-pilote.md` du socle (ADR 0019,
plan §13.1, lot 8). La production de pilote-certif a quitté le compte B
(Miijot, `b8505b…`) pour le compte Cloudflare mutualisé (`305a2bac…`, zone
SaaS dg-tech.dev) : sauvegardée sur B, recréée et restaurée sur le compte
mutualisé, déployée avant la bascule, puis son domaine basculé par un CNAME
vers `fallback.dg-tech.dev`. B a été détruit après le premier Nightly
programmé de la flotte, vert. Travail d'après le pilote, hors des jalons 0 à 10.

Les commandes sur un compte ont été lancées par Damien, jetons saisis dans son
terminal (`read -rs`), jamais dans la session ; l'agent a préparé chaque
geste, lu les sorties, les runs GitHub et la boutique de l'extérieur, monté le
socle (#43), écrit le registre de la flotte et ouvert #44, que Damien a
fusionnées. Les heures sont en UTC. Les adresses électroniques sont masquées
(`<email>`), les chemins du poste écrits depuis `~`.

## Les fichiers

| Fichier | § de la fiche | Ce qu'il montre |
|---|---|---|
| `0-provision-B-dry-run.txt`, `0-provision-B.txt` | 0 | sur B en `v0.3.33` : la base marquée (« base antérieure au marqueur »), la règle des archives remplacée, celle du pool posée, les secrets conservés |
| `1-backup-B.txt` | 1 | moyens de paiement déjà inactifs ; l'archive du jour J `pilote-certif-production-20261029T172928Z` (106 lignes, 8 images, clé `a08808754f049baf`), `pull` et `verify` verts |
| `2-provision-mutualise-dry-run.txt` | 2 | la simulation sur le compte mutualisé |
| `2-provision-mutualise-echec-1.txt` | 2 | le premier passage, en échec (code 7404), et sa cause : le défaut 1 ci-dessous |
| `2-provision-mutualise.txt` | 2 | le second passage, vert : base, buckets, règles, nom d'hôte créé en attente du DNS |
| `2-restore-mutualise.txt` | 2 | restauration inter-comptes : 26 tables identiques à l'archive, 8 objets reversés, Resend et Turnstile illisibles |
| `2-turnstile-et-deploy-mutualise.txt` | 2 | Turnstile coupé par la commande que la restauration affiche ; `deploy --skip-smoke` avant la bascule, `AUTH_SECRET` et `SECRETS_KEK` générés |
| `3-bascule.txt` | 3 | la bascule vue de l'extérieur toutes les quinze secondes, la coupure, puis `provision` : nom d'hôte actif, certificat actif |
| `4-flotte.txt` | 4 | `fleet init`, `fleet repo` : `DamienGR/minshop-fleet` public, trois environnements, la clé, le plan gratuit |
| `5-repo-fleet.txt` | 5 | `repo --fleet` : `MINSHOP_FLEET` posée, les six secrets de B nommés et gardés pour le retour arrière |
| `6-remise-en-etat.txt` | 6 | clés ressaisies, e-mail de test reçu, reconnexion avec le widget, images sur dg-tech.dev |
| `6-nightly-flotte-40966588970.txt` | 6 | le Nightly de la flotte lancé à la main : sauvegarde réutilisant le pool, `verify`, `monitor`, `fleet usage` verts |
| `7-nightly-programme-41037762590.txt` | 7 | la nuit verte qu'attend la destruction : le premier run programmé du dépôt de flotte |
| `7-destroy-B-dry-run.txt`, `7-destroy-B.txt` | 7 | la destruction de B, simulation puis six ressources supprimées ; le dépôt de la boutique nettoyé ; les jetons de B révoqués |
| `7-nightly-apres-revocation-41056994612.txt` | 7 | un Nightly lancé à la main après la révocation : les jetons de la flotte tiennent |

## Ce qui s'est passé

- **Le premier `provision` sur le compte mutualisé a échoué.** La sauvegarde du
  §1 avait rendu `wrangler.jsonc` pour la production de B ; wrangler a pris
  l'identifiant de la base de B pour poser le marqueur, inconnu du compte
  mutualisé. Damien a remis le fichier (`git checkout -- wrangler.jsonc`) et
  relancé : vert, la base neuve marquée au second passage.
- **La bascule** : le domaine retiré du Worker de B à 21:20:58, le CNAME vu
  par 1.1.1.1 à 21:22:29, le certificat du nom d'hôte émis vers 21:24:20. Le
  résolveur du poste, qui avait demandé le nom pendant le trou, ne l'a revu
  qu'à 21:46:44 : **vingt-six minutes de coupure** vues du poste, dont
  vingt-deux de cache négatif (minimum du SOA de miijot.fr, 1 800 s). La fiche
  en annonçait cinq.
- **La nuit** : le run programmé de 03:17 est parti à 10:02, comme ceux du
  socle et de la boutique les jours d'avant (GitHub les lance cinq à sept
  heures après leur heure). 0 erreur sur 1 144 requêtes, un seul Worker sur le
  compte.
- **La fermeture de B** : le domaine d'images retiré du bucket de B, les
  buckets vidés, `destroy` vert. Le dépôt de la boutique n'a plus aucun secret
  ni environnement ; seules restent les variables `MINSHOP_FLEET` et
  `STAGING_RETIRED`. B garde la zone miijot.fr, qui porte le CNAME de la
  boutique et les enregistrements Resend.

## Ce qui ne laisse pas de fichier

- **Dans le tableau de bord du compte mutualisé** : le domaine d'images
  `images-certif-minshop.dg-tech.dev` attaché au bucket d'images, « Active » ;
  le widget Turnstile du lot de dix, créé au §0.
- **Dans le tableau de bord de B** : le domaine `certif-minshop.miijot.fr` retiré
  du Worker, le CNAME `certif-minshop → fallback.dg-tech.dev` en DNS seul, puis
  au §7 le domaine `images-certif-minshop.miijot.fr` retiré du bucket et les
  buckets vidés (Empty Bucket).
- **La révocation des jetons de B** (My Profile → API Tokens, et les jetons du
  compte Miijot) : ceux qui portaient sur B, soit le jeton de déploiement
  `minshop-pilote-certif-production-lot8` créé pour le jour J, l'ancien jeton
  de déploiement, celui de sauvegarde et celui de lecture. Trois jetons du
  compte mutualisé restent, vus par Damien.
- **L'archive du jour J** reste sur le poste, chiffrée, jusqu'au 2027-01-28,
  le temps que la flotte en ait quatre-vingt-dix jours.

## Les écarts à la fiche

Acceptés par Damien :

1. **la clé de sécurité matérielle** de l'utilisateur du compte mutualisé,
   commandée, n'était pas arrivée : la migration s'est faite sous la double
   authentification par application, l'écart du lot 3 maintenu. La clé se pose
   à réception ;
2. **aucune attente de trente minutes au §1** : aucun moyen de paiement
   n'était actif (clés Stripe retirées à l'étape 10), donc aucune session de
   paiement ne pouvait être ouverte ;
3. **un nouveau jeton de déploiement sur B** pour le jour J
   (`minshop-pilote-certif-production-lot8`) : la valeur de l'ancien n'était
   plus connue. Créé plutôt que renouvelé, parce que l'ancien était encore
   dans l'environnement `production` de ce dépôt, pour le retour arrière ;
4. **les noms des jetons révoqués sur B** n'ont pas été relevés au moment de
   la suppression.

## Les défauts trouvés

Corrigés par le socle `v0.3.34` (pull request DamienGR/minshop-platform#134 ;
sa fiche, §10) :

1. `provision` posait le marqueur vers la base nommée par un `wrangler.jsonc`
   rendu pour un autre compte, et disait la base « marquée » avant de l'avoir
   écrit. Le même piège attendait `backup`, `deploy`, `restore` et `destroy` ;
   la doublure du 2026-10-28 l'avait manqué, son wrangler lisant mal la
   configuration ;
2. la fiche faisait `git commit -am`, qui emportait `wrangler.jsonc` ;
3. le retour arrière de la fiche aurait échoué sans `--key-file` ;
4. la fiche donnait la clé `64fb…` ; c'est `a08808754f049baf` ;
5. la fiche annonçait cinq minutes de coupure ;
6. `repo --fleet` disait les secrets de B « jeton du compte mutualisé » ;
7. `deploy` écrivait « déployé — https://certif-minshop.miijot.fr » avec un nom
   d'hôte en attente ;
8. la fiche parlait de trois environnements à supprimer (il y en avait deux,
   et les deux secrets de surveillance du dépôt restaient après eux), ne
   disait ni le retard du cron, ni que les buckets des deux comptes portent les
   mêmes noms, ni que la page des jetons liste ceux des deux comptes.
