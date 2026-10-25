# Dossier de décision du pilote (jalon 10, point F)

Ce dossier assemble ce que la campagne a produit pour une seule question, celle
du point de décision F du [plan d'implémentation](../implementation-plan.md)
(§11) : **la commercialisation peut-elle commencer ?** Le critère de sortie du
jalon 10 est que chaque critère du §8 soit tenu, ou fasse l'objet d'une
dérogation écrite, datée et accompagnée d'une mesure compensatoire.

Assemblé le 2026-10-25, à la fin de l'étape 10, d'après le
[plan de certification](plan.md) et les preuves versées dans
`client/certification/` des dépôts `shop-pilote-certif` et
`shop-canari-certif`. La production du pilote est en `v0.3.24`, sans clé
Stripe live ; `v0.3.25` ferme les écarts trouvés en préparant l'étape 11
([fiche](etape-11-commandes.md)).

Les sections 3 et 6 se signent sur un exemplaire gardé hors du dépôt : celui-ci
est public par ses boutiques.

## 1. Livrables du jalon 10

| Livrable | Où | État au 2026-10-25 |
|---|---|---|
| rapport de tests | section 2 de ce dossier, d'après les étapes 3, 4, 6 et 7 | assemblé |
| rapport de sécurité | [rapport-securite.md](rapport-securite.md) | neuf lignes tenues sur le staging, la porte distante 17/17 sur la production ; l'audit des dépendances rouge depuis le 2026-10-24, fermé par `v0.3.25` |
| rapport de performance | [rapport-performance.md](rapport-performance.md) | cinq lignes tenues ; la décision sur le CPU reste à prendre (section 5) |
| preuve de restauration | étape 8, pull request #20 du pilote | restauration sur B en 29 min 21 s, 26 tables identiques à l'archive |
| validation TVA/facturation | étape 11, section 3 de la fiche | à obtenir |
| checklist de lancement | [mise-en-ligne.md](../operations/mise-en-ligne.md) | écrite à l'étape 9, complétée aux étapes 10 et 11 |
| documentation de support | section 4 | complète en `v0.3.25`, à relire |
| décision go/no-go | section 6 | à prendre |

## 2. Critères du §8

« Tenue » veut dire passée sur un compte réel, preuve versée. Les numéros de
pull request renvoient au dépôt du pilote, sauf mention.

### 8.1 Fonctionnel

| Ligne | État | Preuve |
|---|---|---|
| catalogue, recherche, catégories, pagination, variantes, stock, panier, livraison | tenue | étape 4, parcours ligne par ligne sur ordinateur et téléphone (#9) ; la pagination avec cinq produits ajoutés |
| promotions | tenue | étape 4, `CERTIF10` : 42,40 − 4,24 + 5,90 = 44,06 €, dont 7,34 € de TVA |
| paiement, remboursement, e-mails | tenue | étape 4 en mode test (#9), étape 10 en argent réel (#32) |
| administration, export | tenue | étape 4 (#9) |
| pages légales | tenue pour le fonctionnement | publiées, au pied de page, la case CGV (étape 4). Leur contenu est au §8.8 |

### 8.2 Paiement et cohérence

| Ligne | État | Preuve |
|---|---|---|
| les sept lignes | tenues | étape 4 : quatre commandes, chacune avec son identifiant Stripe, sa ligne D1 et son stock avant et après, le webhook rejoué, la panne de Resend (#9) ; étape 10 : le même `pi_…` partout, 115 centimes de TVA, le stock à 0, un remboursement et un e-mail (#32) |

### 8.3 Isolation multi-client

| Ligne | État | Preuve |
|---|---|---|
| les huit lignes | tenues | la porte d'isolation à chaque commit ; les lignes des boutiques déployées à l'étape 7 : deux Workers, deux bases, six buckets, aucun produit croisé, l'import croisé refusé, `destroy` de l'une sans l'autre (#10 de `shop-canari-certif`) |

### 8.4 Sécurité

| Ligne | État | Preuve |
|---|---|---|
| aucune vulnérabilité critique ou élevée non justifiée | **rouge depuis le 2026-10-24**, fermée par `v0.3.25` | aucune à l'étape 5 (#11) ; deux alertes élevées publiées depuis (`undici`, `zod`), le nocturne du pilote rouge les 24 et 25 octobre ; à refermer par la montée et un nocturne vert (fiche, section 1) |
| aucune clé dans Git, les journaux ou les artefacts | tenue | étape 5 : l'arbre, tout l'historique et les artefacts du build (#11) |
| webhooks signés, routes admin protégées, limiteurs actifs, uploads contrôlés, aucune donnée de carte | tenues | porte distante 18/18 sur le staging (#13), 17/17 sur la production (étape 9, #27) |
| aucune PII inutile dans les journaux | tenue | étape 5 : 531 événements de `wrangler tail` et la trace du webhook relus (#11) |
| CSP et en-têtes présents | tenue sous dérogation | `script-src` et `style-src` (section 3) |

### 8.5 Accessibilité et navigateurs

| Ligne | État | Preuve |
|---|---|---|
| axe, clavier, focus, zoom 200 %, contrastes | tenues | porte navigateur contre le staging en `v0.3.9` : 85 passés, 5 sautés avec leur raison (#18) |
| Chrome desktop, Firefox desktop, Chrome Android | tenues | achats à la main, étapes 6 et 9 (#18, #27) |
| Safari/iPhone | dérogation | section 3 |

### 8.6 Performance

| Ligne | État | Preuve |
|---|---|---|
| Lighthouse mobile ≥ 90, LCP ≤ 2,5 s, CLS ≤ 0,1, INP ≤ 200 ms | tenues | 100 / 100 / 92, LCP 1,0 à 1,6 s, CLS 0, INP 24 ms (#18) |
| aucune erreur sous charge, vingt acheteurs quinze minutes | tenues | 6 528 requêtes, aucune erreur, aucune invocation arrêtée (#18) |
| cinq checkouts concurrents sans survente | tenue | une session, quatre `409` (#18) |

Le CPU n'est pas une ligne du §8, mais le §8.6 demande le plan Workers Paid
si le plan gratuit dépasse régulièrement sa limite : la décision est à la
section 5.

### 8.7 Résilience

| Ligne | État | Preuve |
|---|---|---|
| Resend indisponible | tenue | étape 4 : clé révoquée, commande écrite, e-mails partis au balayage suivant (#9) |
| webhook Stripe répété | tenue | étape 4 : aucune seconde commande, aucun remboursement compté deux fois (#9) |
| média R2 manquant | tenue | étape 8 : la fiche en 200, l'image en 404 sans exception (#20) |
| échec réseau temporaire | **sans ligne de campagne** | aucune étape ne le rejoue ; tenue par les tests du socle (file d'e-mails relâchée puis retentée, étiquette d'expédition à l'issue ambiguë) et vue en réel trois fois : une lecture D1 distante en échec puis passée (étapes 9 et 10), la propagation de Cloudflare attendue par le test de fumée (étape 7). Section 5 |
| rotation des secrets | tenue | étape 8 : `AUTH_SECRET`, les sessions tombent et rien d'autre (#20) ; la clé Resend remplacée à l'étape 4 |
| mot de passe admin perdu | tenue | étape 8, le runbook suivi tel quel (#20) |
| rollback Worker | tenue | étape 8 : la version précédente à 100 %, puis retour (#20) |
| restauration complète, RTO ≤ 60 min | tenues | étape 8 : 29 min 21 s vers le compte B (#20) |
| RPO ≤ 24 h | **tenue au sens « une archive par nuit »** | cinq nuits de suite à l'étape 8, la production chaque nuit depuis l'étape 9 ; mais GitHub lance le cron de 03:17 entre 8 et 9 h UTC, et deux archives ont été séparées de 24 h 54 sur le staging (18 → 19 octobre), 24 h 18 sur la production (24 → 25 octobre). Section 5 |

### 8.8 Conformité et validation humaine

| Ligne | État | Preuve |
|---|---|---|
| revue des pages légales | **ouverte** | les quatre pages de la production sont des squelettes (fiche de l'étape 11) |
| revue du consentement aux CGV | **ouverte** | le mécanisme tient (étape 4) ; le texte accepté reste à écrire, puis `termsVersion` à 2 |
| revue TVA et facturation | **ouverte** | l'expert-comptable (fiche, section 3) |
| commande réelle, remboursement réel | tenues | étape 10 : `tspzkyxggc`, 6,90 €, remboursée par l'administration (#32) |
| e-mails dans Gmail, Outlook et Apple Mail | Gmail tenu ; Outlook et Apple Mail sous dérogation | section 3 |
| recette par une personne extérieure | **ouverte** | [recette.md](../operations/recette.md) |
| textes définitifs sous la responsabilité du marchand | **ouverte** | la [matrice des responsabilités](../operations/responsabilites.md) et le procès-verbal de recette, à signer |

## 3. Dérogations à signer

Chacune est écrite au §6 du plan, avec sa mesure compensatoire et ce qui la
rouvre. Signer, c'est accepter le risque restant pour la commercialisation.

Sur une ligne du §8, donc exigées par le critère de sortie :

| Dérogation | Écrite le | Risque restant | Se rouvre quand | Acceptée (date, signature) |
|---|---|---|---|---|
| CSP : `script-src` et `style-src` (§8.4) | 2026-10-06 | un script injecté s'exécuterait ; aucune voie d'injection connue (Markdown sans HTML, échappement d'Astro) | l'inventaire des scripts en ligne est fait | |
| achat sur Safari, iPhone (§8.5) | 2026-10-23 | un défaut propre à WebKit, de rendu ou de formulaire | un iPhone est disponible, ou la porte navigateur gagne un projet WebKit | |
| e-mails dans Outlook et Apple Mail (§8.8) | 2026-10-25 | un rendu propre à ces messageries | la première commande réelle d'un commerçant qui lit ses alertes dans Outlook | |

Hors du §8, prévues au même §6 sans date : à dater en les signant.

| Dérogation | Risque restant | Se rouvre quand | Acceptée (date, signature) |
|---|---|---|---|
| test de fumée avant promotion (§5.5, jalon 6) | une version cassée sert jusqu'au retour arrière que le test de fumée public nomme | Cloudflare ouvre les déploiements graduels à ce plan | |
| approbation de production opposable (§9) | sans objet pour le pilote, dont les dépôts sont publics ; une boutique privée demande GitHub Pro, ou repose sur `--yes` et un seul ayant droit | une boutique en dépôt privé | |
| critère 320 px de WCAG 1.4.10 (jalon 5) | un débordement horizontal sur un très petit écran, mesuré et non gaté ; le §8.5 demande le zoom à 200 %, tenu | une boutique annonce la conformité WCAG, ou la porte navigateur le gate | |

S'y ajoutent, selon les décisions de la section 5, une dérogation sur le CPU,
sur le RPO, ou sur l'échec réseau temporaire.

## 4. Documentation du §12

| Document exigé | Fichier | Remarque |
|---|---|---|
| architecture et ADR | [ADR 0000 à 0018](../architecture/decisions/README.md), [inventaire de la baseline](../architecture/baseline-inventory.md) | |
| guide de création d'une boutique | [plan de certification](plan.md), étapes 1 à 3, avec [comptes-et-acces.md](comptes-et-acces.md) ; [`shopctl`](../agents/shopctl.md) | écrit comme la campagne, rejouable par boutique ; la page `shopctl` est en anglais |
| guide d'import de catalogue | [catalogue.md](../agents/catalogue.md), et `imports/README.md` généré dans chaque boutique | en anglais |
| guide de personnalisation du thème | [CUSTOMIZING.md](../../CUSTOMIZING.md) | en anglais |
| procédure Stripe et Resend | [comptes-et-acces.md](comptes-et-acces.md) §1 et §3, [mise-en-ligne.md](../operations/mise-en-ligne.md) §5 | |
| procédure de déploiement | [mise-en-ligne.md](../operations/mise-en-ligne.md) | |
| sauvegarde et restauration | [backup.md](../agents/backup.md), runbook [base-corrompue](../operations/runbooks/base-corrompue.md) | |
| mise à niveau du socle | [`shopctl`](../agents/shopctl.md) (`core upgrade`), [notes de migration](../migrations/README.md) | |
| incident et violation de données | [runbooks](../operations/README.md), dont [violation-de-donnees](../operations/runbooks/violation-de-donnees.md) | |
| procédure de remboursement | [remboursement.md](../operations/remboursement.md) | écrite pour l'étape 11 |
| départ d'un client | [sortie-client.md](../operations/sortie-client.md) | |
| matrice des responsabilités agence/marchand | [responsabilites.md](../operations/responsabilites.md) | écrite pour l'étape 11 |
| liste des sous-traitants techniques | [sous-traitants.md](../operations/sous-traitants.md) | écrite pour l'étape 11 ; les garanties de transfert sont à vérifier sur le contrat de chaque fournisseur |
| modèle de recette et de procès-verbal de livraison | [recette.md](../operations/recette.md) | écrit pour l'étape 11 |

Trois guides sont en anglais : ils s'adressent aux contributeurs du socle. Les
traduire n'est nécessaire que si un commerçant ou un prestataire français doit
les suivre seul.

## 5. Décisions à prendre avant le go/no-go

1. **Le CPU.** Le rapport de performance pose trois issues : rester au plan
   gratuit sous dérogation, passer au plan Workers Paid, activer le cache de
   Workers. La surveillance nocturne de la production, qui échoue dès qu'une
   invocation est arrêtée, est verte les 24 et 25 octobre, les deux nuits
   relevées.
   Recommandation : **rester au plan gratuit, sous dérogation**, avec la
   surveillance pour mesure compensatoire et le passage au plan payant pour
   remède écrit (runbook [worker-en-erreur](../operations/runbooks/worker-en-erreur.md)).
2. **Le RPO.** Une archive par nuit, mais l'heure à laquelle GitHub lance le
   cron varie d'une nuit à l'autre, et l'écart a déjà dépassé 24 heures. Deux
   remèdes : un second déclenchement dans la journée qui ne lance que la
   sauvegarde de la production (un changement du nocturne, dans une version
   suivante du socle), ou une dérogation qui définit le RPO comme « une
   archive par nuit », avec l'archive que prend chaque déploiement.
   Recommandation : **le second déclenchement**, qui ferme la ligne au lieu
   de la redéfinir.
3. **L'échec réseau temporaire.** Aucune étape ne l'a rejoué tel quel.
   Recommandation : **la tenir par les preuves de la section 2**, en l'écrivant
   ici, plutôt que d'inventer une panne pour la campagne.

## 6. Décision (point F)

Conditions d'un **go** :

- chaque critère de la section 2 tenu, ou sous une dérogation signée à la
  section 3 ;
- la validation écrite de l'expert-comptable, et `invoiceStrategy` qui en dit
  le résultat (ADR 0010 : sans elle, aucune boutique ne passe en production
  pour vendre) ;
- le procès-verbal de recette signé, sans anomalie bloquante ;
- `v0.3.25` publiée, le pilote monté, un nocturne vert.

Ce que la décision dit aussi : ce que devient la boutique `pilote-certif`
(laissée fermée, rouverte avec des clés live pour vendre, ou supprimée par
`shopctl destroy --env production`), et ce qui est promis au premier client
(les limites du plan gratuit, `/mnt/project-files/analyses/limites-tiers-gratuits.md`
dans le projet).

| | |
|---|---|
| Décision | ☐ go ☐ go sous conditions ☐ no-go |
| Conditions, s'il y en a | |
| Date | |
| Pour l'agence | |
| Pour le commerçant du pilote | |
