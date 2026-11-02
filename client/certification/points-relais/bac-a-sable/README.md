# Points relais — la répétition sur le bac à sable (lot 6, partie A)

Passée les 1er et 2 novembre 2026 selon la fiche
`docs/certification/points-relais-commandes.md` du socle (ticket #123, plan
§13.3, lot 6 ; ADR 0020 et 0021). Une staging temporaire de pilote-certif sur
le compte Cloudflare mutualisé (`305a2bac…`, sous-domaine workers.dev
`dg-tech`), le bac à sable de Boxtal, Stripe en mode test, Resend vers Gmail.
Partie sur le socle `v0.3.35`, elle a trouvé un défaut, corrigé dans `v0.3.36`
(socle #144) et vérifié sur la même staging avant sa destruction.

La session wrangler du poste n'atteint pas le compte mutualisé : Damien a posé
un jeton du compte dans un fichier du poste, lisible par lui seul (mode 600),
le temps de la partie A ; l'agent l'a lu pour lancer `provision`, `deploy`,
`destroy` et les lectures de la base, sans jamais l'afficher ni le passer en
argument. Le fichier a été effacé après A9, le jeton gardé dans le
gestionnaire de mots de passe. Damien a fait tous les gestes de navigateur :
le mot de passe de l'administration, les réglages, les commandes, les
étiquettes, Stripe, Resend. L'agent a lu la base, les e-mails (Gmail, par son
connecteur) et les pull requests.

**Sans capture**, par décision de Damien (2026-11-01) : ses constats écrits
ci-dessous remplacent `points.png`, `telephone-points.png`, `export.png` et
`sans-point.png`. L'alerte de commande va dans Gmail, Damien n'ayant pas de
messagerie Outlook. Les heures sont en UTC. L'adresse de l'acheteur, son nom,
son e-mail et le jeton invité de « Voir ma commande » sont masqués ; le PDF de
l'étiquette et l'export CSV complet restent hors du dépôt (ils portent le nom
et l'adresse de l'expéditeur, les e-mails).

## Les fichiers

| Fichier | Étape | Ce qu'il montre |
|---|---|---|
| `journaux/0-verif-compte.txt` | §0 | le compte mutualisé, le sous-domaine `dg-tech`, un seul cron sur le compte avant la staging |
| `journaux/a1-provision.txt` | A1 | base et trois buckets créés en juridiction `eu`, base marquée, règles de conservation, migrations appliquées |
| `journaux/a1-deploy.txt` | A1 | extrait : `verify` vert, `AUTH_SECRET` et `SECRETS_KEK` générés, le test de fumée avant l'assistant (302 vers `/admin/setup`) |
| `marqueur.json` | A1 | la base marquée pour `damiengr/shop-pilote-certif` |
| `livraison-schema.txt`, `boxtal-reglages.json` | A2 | la configuration de livraison au schéma 4 ; quatre clés `enc:boxtal_` (v3 et v1), aucun `boxtal_environment` (bac à sable) |
| `commande-relais.json` | A4 | `ord_hx922abzcn` : payée, 13,90 € dont 3,90 € de livraison, `relay`, `stripe`, `MONR-CpourToi`, le point 41132, `FR`, téléphone présent |
| `reservation-relais.json` | A4 | le point gardé, l'adresse effacée au règlement (1, 1) |
| `notifications-relais.json` | A4 | la confirmation et l'alerte `sent` |
| `emails/a4-confirmation.txt`, `emails/a4-alerte.txt` | A4 | « Votre point relais » ; « Point relais choisi » et « Code du point : 41132 » |
| `etiquette-relais.json`, `suivi-relais.json` | A5 | l'étiquette relais `purchased` chez Boxtal, 3,84 € HT ; le numéro et l'URL de Mondial Relay ; **`tracking_carrier = other`** : le défaut |
| `emails/a5-expedition.txt` | A5 | l'e-mail d'expédition, sans la ligne du transporteur |
| `commande-domicile.json`, `etiquette-domicile.json`, `emails/a6-domicile.txt` | A6 | `ord_sbchdmtkc8` à domicile, Colissimo, sans point ; « Transporteur : Colissimo » |
| `commande-taxe-sans-immatriculation.json` | A7 | premier essai, `ord_s0p0kxxva8` : Stripe accepte la session, taxe 0 faute d'immatriculation |
| `commande-taxe.json` | A7 | `ord_t0t1h31tet` : 16,68 € = 10,00 + 3,90 + 2,78 de taxe, `relay` |
| `export-colonnes.txt` | A8 | les colonnes `Delivery`, `Relay point code`, `Relay point` de l'export, sans e-mail |
| `journaux/v0.3.36-deploy.txt` | v0.3.36 | extrait : la staging redéployée au socle corrigé, fumée verte |
| `v0.3.36-etiquette-relais.json`, `v0.3.36-suivi-relais.json`, `emails/v0.3.36-expedition.txt` | v0.3.36 | l'étiquette relais de `ord_t0t1h31tet` : « Mondial Relay », « C.pourToi® », `tracking_carrier = mondialrelay`, « Transporteur : Mondial Relay » |
| `journaux/a9-destroy-simulation.txt`, `journaux/a9-destroy.txt` | A9 | la simulation puis la destruction : Worker, KV des sessions, trois buckets, base |

## Le déroulé

- **1er novembre au soir** : montée du pilote au socle `v0.3.35` (pilote#46,
  sans conflit) et interrupteur `features.relayPoints` (pilote#47), CI vertes,
  fusionnées par Damien. Staging provisionnée à 21:52, déployée à 22:01.
- **A4**, 22:27 : la commande en relais, payée par carte de test.
- **A5**, 22:44 : l'étiquette relais ; le numéro à 22:45:48.
- **A6**, 22:55 : la commande à domicile et son étiquette Colissimo.
- **A7**, 23:07 : premier essai de Stripe Tax ; le second le 2 novembre à 08:54,
  après l'immatriculation test.
- **A8**, le 2 novembre au matin : l'export, les adresses inconnues.
- **v0.3.36** : socle #144 fusionné, Release publiée à 09:31 ; montée
  pilote#49 (CI 20/20) fusionnée ; staging redéployée à 09:57 ; étiquette
  relais achetée sur `ord_t0t1h31tet` à 10:00:53, e-mail d'expédition à 10:01:32.
- **A9**, 10:25 : staging détruite. L'adresse répond 404 ; il ne reste sur le
  compte que la base, le KV et les buckets de la production. La variable
  `STAGING_RETIRED`, posée le 2026-10-23, était déjà là. Puis Damien a supprimé
  la clé restreinte et l'endpoint de webhook Stripe de test, révoqué la clé
  Resend, effacé le fichier du jeton.

## Ce qui ne laisse pas de fichier

- **La première recherche de points** : moins d'une seconde (Damien). Le
  rechargement n'a pas été chronométré.
- **Sans JavaScript et sur un téléphone** : la liste des points est un
  formulaire qui marche sans script, et elle se lit sur le téléphone de Damien
  (constats écrits, pas de capture).
- **Le délai entre l'achat et le numéro de suivi** : en relais, Damien voit le
  numéro dès le premier « Relire le suivi », en moins de cinq secondes ; en
  base, 22:44:33 pour l'étiquette et 22:45:48 pour le numéro, c'est-à-dire le
  temps jusqu'au clic. À domicile, pas chronométré. Avec `v0.3.36`, l'e-mail
  d'expédition part 39 s après l'achat.
- **La page de Mondial Relay** pour un numéro du bac à sable : « Nous n'avons
  identifié aucun colis portant ce numéro de suivi 😞 ». Attendu : le numéro
  n'existe pas chez Mondial Relay.
- **Le PDF de l'étiquette relais** : un bordereau générique A4 du bac à sable
  (« Test Carrier », « Test Service »), adressé à l'acheteur, qui **ne nomme
  pas le point**. La boutique envoie bien le code du point à Boxtal (et le bac
  à sable refuse un point inconnu, corpus `17`) : le point se vérifie sur la
  vraie étiquette, en B5. Colis saisi : 10 × 20 × 10 cm et 500 g, les valeurs
  préremplies.
- **La taxe de Stripe en A7** : 2,78 € de TVA pour 13,90 €, 16,68 € au total,
  la taxe ajoutée au prix. Stripe a **accepté** la session sans adresse de
  livraison et n'a demandé que le pays, sous la carte. Les Taxes automatiques
  ont été éteintes juste après (`tax_enabled = 0`, relu).
- **L'export** : `relay`, `41132` et ART THE ZEN sur les commandes d'A4 et d'A7,
  `shipping` et aucun point sur celle d'A6.

## Ce qui a accroché

1. **Le transporteur d'une étiquette relais (défaut du socle).** En A5, la
   commande expédiée portait `tracking_carrier = other` : `homeOffer()` ne
   connaissait que les offres à domicile. L'e-mail d'expédition n'avait pas
   la ligne « Transporteur », la fiche commande disait « Autre », l'export
   `other`. Le lien de suivi était juste. Corrigé dans `v0.3.36` (socle #144 :
   `boxtalOffer()`, à l'achat et au rapprochement d'une étiquette incertaine,
   avec ses tests) ; vérifié ici sur une étiquette relais neuve : base, admin
   et e-mail disent Mondial Relay. La commande d'A4, expédiée sous `v0.3.35`,
   garde `other`.
2. **Stripe Tax en mode test sans immatriculation.** Le premier essai d'A7 a
   affiché « Taxe 0,00 € », l'infobulle disant qu'aucune immatriculation ne
   correspond. Le lien des immatriculations mène, en mode test, à une page
   « Le suivi des obligations n'est pas disponible dans l'environnement de
   test » ; l'immatriculation test se pose par « Collecter et déclarer » →
   « Commencer à percevoir des taxes » (trouvé par Damien). Fiche corrigée.
3. **Une adresse inconnue reçoit quand même des points.** Avec le code postal
   `99999` et une ville, le bac à sable de Boxtal a rendu des points dans la
   Creuse (« Les plus proches de 99999 … », à 13 km) ; avec `00000` et
   d'autres villes inventées, des points différents selon la ville : Boxtal
   cherche sur le nom. Avec `00000` et la ville « Setouk », plus de Mondial
   Relay, Colissimo seul, sans erreur : le repli de `/checkout` vu sur la
   staging. Pas un défaut de la boutique, qui montre ce que Boxtal répond ;
   la fiche ne promet plus « Colissimo seul » pour `99999`.
4. **Une apostrophe doublée** dans une rue rendue par le bac à sable :
   « 42 AVENUE D''AUVERGNE ». La boutique recopie la rue telle quelle ; à
   regarder sur les données de production en B4.
5. **Les écarts de la fiche**, corrigés dans `v0.3.36` : l'accueil répond 302
   vers `/admin/setup` tant que l'assistant n'est pas fait ; le marqueur écrit
   le dépôt en minuscules ; le stock d'un nouveau produit vaut 0 (laissé tel
   quel, l'article est « Épuisé » : Damien l'a mis à 5) ; Outlook facultatif ;
   la fusion des pull requests dans le navigateur ; `npm ci` (npm 12) signale
   des scripts d'installation bloqués (esbuild, workerd), sans effet.

## Ce que cela coche

- **La campagne en doublure sur le bac à sable** : une commande en relais et
  une à domicile payées par carte via `/checkout`, Stripe sans adresse, une
  étiquette de chaque sorte avec son suivi et son URL — tenue, avec le défaut
  du transporteur corrigé en `v0.3.36` et revérifié.
- **Stripe Tax sur une session sans adresse de livraison** : la taxe calculée
  sur l'adresse de facturation — tenue.
- **La liste des points sans JavaScript et sur un téléphone** — tenue, par
  constat écrit.
- **Une recherche sans point ne bloque pas la commande** — tenue (« Setouk ») ;
  le bac à sable rend des points pour la plupart des adresses inventées.

La partie B, la commande réelle, part du socle `v0.3.36` et attend le feu vert
de Damien.
