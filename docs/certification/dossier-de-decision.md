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

Mis à jour le 2026-10-25 au soir, pendant l'étape 11 : la production est en
`v0.3.26` (montée #37, run `Deploy` 40236611288), le nocturne 40237706569 est
vert, audit des dépendances compris, et les décisions de la section 5 sont
prises.

Mis à jour le 2026-10-26 : `v0.3.27` est publiée et la montée du pilote
ouverte (#40) ; les quatre pages légales sont en ligne, sans marqueur. Deux
décisions s'ajoutent à la section 5 : la relecture juridique et la validation
comptable attendent la première boutique réelle, sous dérogation (section 3),
et la recette du pilote est tenue par les preuves des étapes, la personne
extérieure reportée à la même boutique.

Les sections 3 et 6 se signent sur un exemplaire gardé hors du dépôt : celui-ci
est public par ses boutiques.

## 1. Livrables du jalon 10

| Livrable | Où | État au 2026-10-25 |
|---|---|---|
| rapport de tests | section 2 de ce dossier, d'après les étapes 3, 4, 6 et 7 | assemblé |
| rapport de sécurité | [rapport-securite.md](rapport-securite.md) | neuf lignes tenues sur le staging, la porte distante 17/17 sur la production ; l'audit des dépendances, rouge les 24 et 25 octobre, vert de nouveau en `v0.3.26` |
| rapport de performance | [rapport-performance.md](rapport-performance.md) | cinq lignes tenues ; le CPU au plan gratuit, sous dérogation (section 3) |
| preuve de restauration | étape 8, pull request #20 du pilote | restauration sur B en 29 min 21 s, 26 tables identiques à l'archive |
| validation TVA/facturation | étape 11, section 3 de la fiche | reportée à la première boutique réelle, sous dérogation (section 3) ; le courrier et ses cinq questions sont prêts, hors du dépôt |
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
| aucune vulnérabilité critique ou élevée non justifiée | tenue | aucune à l'étape 5 (#11) ; deux alertes élevées publiées depuis (`undici`, `zod`), le nocturne du pilote rouge les 24 et 25 octobre ; montées en `v0.3.25`, le pilote en `v0.3.26` (#37) et son nocturne 40237706569 vert, « Dependency audit » compris (étape 11) |
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
si le plan gratuit dépasse régulièrement sa limite : Damien a choisi le plan
gratuit sous dérogation (section 5, décision 1).

### 8.7 Résilience

| Ligne | État | Preuve |
|---|---|---|
| Resend indisponible | tenue | étape 4 : clé révoquée, commande écrite, e-mails partis au balayage suivant (#9) |
| webhook Stripe répété | tenue | étape 4 : aucune seconde commande, aucun remboursement compté deux fois (#9) |
| média R2 manquant | tenue | étape 8 : la fiche en 200, l'image en 404 sans exception (#20) |
| échec réseau temporaire | tenue par les preuves (section 5, décision 3) | aucune étape ne le rejoue ; tenue par les tests du socle (file d'e-mails relâchée puis retentée, étiquette d'expédition à l'issue ambiguë) et vue en réel trois fois : une lecture D1 distante en échec puis passée (étapes 9 et 10), la propagation de Cloudflare attendue par le test de fumée (étape 7) |
| rotation des secrets | tenue | étape 8 : `AUTH_SECRET`, les sessions tombent et rien d'autre (#20) ; la clé Resend remplacée à l'étape 4 |
| mot de passe admin perdu | tenue | étape 8, le runbook suivi tel quel (#20) |
| rollback Worker | tenue | étape 8 : la version précédente à 100 %, puis retour (#20) |
| restauration complète, RTO ≤ 60 min | tenues | étape 8 : 29 min 21 s vers le compte B (#20) |
| RPO ≤ 24 h | **à tenir par `v0.3.27`** (section 5, décision 2) | cinq nuits de suite à l'étape 8, la production chaque nuit depuis l'étape 9 ; mais GitHub lance le cron de 03:17 entre 8 et 9 h UTC, et deux archives ont été séparées de 24 h 54 sur le staging (18 → 19 octobre), 24 h 18 sur la production (24 → 25 octobre). `v0.3.27` sauvegarde la production une seconde fois, à 15:17 UTC : la ligne est tenue quand le pilote l'a prise et qu'un run de l'après-midi est vert |

### 8.8 Conformité et validation humaine

| Ligne | État | Preuve |
|---|---|---|
| revue des pages légales | sous dérogation (section 3) | les quatre pages de la production écrites en entier, sans marqueur, l'identité fictive du vendeur annoncée en tête de chacune ; la relecture par un conseil attend la première boutique réelle |
| revue du consentement aux CGV | sous dérogation (section 3) | le mécanisme tient (étape 4) ; le texte complet en ligne, `termsVersion` à 2 (#39) ; sa relecture avec celle des pages |
| revue TVA et facturation | sous dérogation (section 3) | `invoiceStrategy` reste `pending-validation` ; les questions de la fiche (section 3) vont à l'expert-comptable de la première boutique réelle |
| commande réelle, remboursement réel | tenues | étape 10 : `tspzkyxggc`, 6,90 €, remboursée par l'administration (#32) |
| e-mails dans Gmail, Outlook et Apple Mail | Gmail tenu ; Outlook et Apple Mail sous dérogation | section 3 |
| recette par une personne extérieure | sous dérogation (section 3) | chaque scénario de [recette.md](../operations/recette.md) joué par les étapes 4 à 11 (section 5, décision 5) ; la personne extérieure attend la recette de livraison de la première boutique réelle |
| textes définitifs sous la responsabilité du marchand | sous dérogation (section 3) | la [matrice des responsabilités](../operations/responsabilites.md) ; le procès-verbal qui le fait confirmer au commerçant se signe à la même recette |

## 3. Dérogations à signer

Chacune est écrite au §6 du plan, avec sa mesure compensatoire et ce qui la
rouvre. Signer, c'est accepter le risque restant pour la commercialisation.

Sur une ligne du §8, donc exigées par le critère de sortie :

| Dérogation | Écrite le | Risque restant | Se rouvre quand | Acceptée (date, signature) |
|---|---|---|---|---|
| CSP : `script-src` et `style-src` (§8.4) | 2026-10-06 | un script injecté s'exécuterait ; aucune voie d'injection connue (Markdown sans HTML, échappement d'Astro) | l'inventaire des scripts en ligne est fait | |
| achat sur Safari, iPhone (§8.5) | 2026-10-23 | un défaut propre à WebKit, de rendu ou de formulaire | un iPhone est disponible, ou la porte navigateur gagne un projet WebKit | |
| e-mails dans Outlook et Apple Mail (§8.8) | 2026-10-25 | un rendu propre à ces messageries | la première commande réelle d'un commerçant qui lit ses alertes dans Outlook | |
| relecture des pages légales et du consentement aux CGV (§8.8) | 2026-10-26 | un texte de commerçant non conforme, ou un point du parcours (la case, le bouton de paiement, le récapitulatif) qu'un conseil jugerait insuffisant, à reprendre dans le socle | la première boutique réelle : ses textes et son parcours relus avant sa mise en ligne | |
| validation TVA et facturation (§8.8) | 2026-10-26 | une réponse qui demande ce que le socle n'a pas : une facture numérotée, la franchise en base, ou le reçu de la boutique comme valeur de `invoiceStrategy` | la première boutique réelle : la réponse écrite de son expert-comptable avant sa mise en ligne | |
| recette par une personne extérieure, et son procès-verbal (§8.8) | 2026-10-26 | ce que seule une personne extérieure voit : un libellé, un chemin, un scénario qu'elle ne suit pas sans explication orale. Chaque scénario n'a été joué que par ceux qui ont construit la boutique, et l'alerte du commerçant n'a jamais été lue en production | la recette de livraison de la première boutique réelle, par son commerçant, procès-verbal signé ([mise en ligne](../operations/mise-en-ligne.md), section 6) | |

Hors du §8, prévues au même §6 sans date : à dater en les signant.

| Dérogation | Risque restant | Se rouvre quand | Acceptée (date, signature) |
|---|---|---|---|
| test de fumée avant promotion (§5.5, jalon 6) | une version cassée sert jusqu'au retour arrière que le test de fumée public nomme | Cloudflare ouvre les déploiements graduels à ce plan | |
| approbation de production opposable (§9) | sans objet pour le pilote, dont les dépôts sont publics ; une boutique privée demande GitHub Pro, ou repose sur `--yes` et un seul ayant droit | une boutique en dépôt privé | |
| critère 320 px de WCAG 1.4.10 (jalon 5) | un débordement horizontal sur un très petit écran, mesuré et non gaté ; le §8.5 demande le zoom à 200 %, tenu | une boutique annonce la conformité WCAG, ou la porte navigateur le gate | |
| CPU au plan gratuit de Workers (§8.6, rapport de performance ; écrite le 2026-10-25) | une boutique dont le trafic rend réguliers les dépassements de 10 ms, que la charge de vingt acheteurs n'a pas produits | la surveillance nocturne relève une invocation arrêtée (erreur 1102) | |

Outre le CPU (décision 1), les deux relectures (décision 4) et la recette
(décision 5), les décisions de la section 5 n'en ajoutent pas : le RPO se ferme par `v0.3.27`, l'échec
réseau temporaire est tenu par les preuves de la section 2.

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

**Décidé par Damien le 2026-10-25**, les trois recommandations suivies :

1. le CPU reste au **plan gratuit, sous dérogation** : écrite au §6 du plan
   et à la section 3, à signer ;
2. le RPO est tenu par **un second déclenchement** : `v0.3.27` sauvegarde la
   production une seconde fois chaque jour, à 15:17 UTC, et ne lance rien
   d'autre à cette heure-là ;
3. l'échec réseau temporaire est **tenu par les preuves** de la section 2.

**Décidé par Damien le 2026-10-26**, deux questions que le pilote pose
lui-même : c'est une boutique de démonstration, au vendeur fictif, qui ne sert
qu'à éprouver le parcours de certification.

4. la **relecture juridique** des pages légales et du consentement aux CGV, et
   la **validation comptable** de la TVA et de la facturation, sont
   **reportées à la première boutique réelle**, sous deux dérogations
   (section 3) : un conseil ou un expert-comptable n'apprendrait rien d'un
   vendeur qui n'existe pas. Le pilote garde `invoiceStrategy:
   pending-validation`, et la [mise en ligne](../operations/mise-en-ligne.md)
   d'une boutique demande les deux avant sa première vente. La décision de la
   section 6 sera un **go sous conditions** ;
5. la **recette** du pilote est **tenue par les preuves** des étapes 4 à 11,
   et la personne extérieure attend la recette de livraison de la première
   boutique réelle, sous dérogation (section 3). Damien l'avait d'abord voulue
   réelle, en production avec un paiement ; il l'a revue le même jour :
   chaque scénario du modèle a déjà été joué, en test et en réel, et le
   procès-verbal ferait signer au vendeur fictif qu'il répond de textes qui
   ne sont pas les siens.

Où chaque scénario de [recette.md](../operations/recette.md) a été joué :

| Scénarios | Preuve |
|---|---|
| V1 à V7 : vitrine, recherche, variantes, panier, stock, livraison, case des CGV | étape 4, le §8.1 ligne par ligne, sur ordinateur et sur mobile (#9 du pilote) |
| V8 : code promotionnel | étape 4, `CERTIF10` : la remise, la TVA calculée après elle |
| V9, V10 : payer, l'e-mail de confirmation | étape 4 en mode test ; étape 10 en réel, `tspzkyxggc`, l'e-mail lu dans Gmail |
| V11 : les pages du pied de page | étape 11 : les quatre pages légales complètes, sans marqueur (`pages-apres.txt`) |
| T1, T2 : téléphone | étape 4 sur mobile ; étapes 6 et 9, l'achat complet sur Chrome Android |
| A1 : connexion | étapes 5 et 9 : la porte de sécurité, le compteur des échecs, Turnstile en production |
| A2 : l'alerte du commerçant | étape 4, sur le staging ; sautée en production à l'étape 10, faute de destinataire, posé depuis |
| A3 : expédition et son e-mail | étape 4 |
| A4 : remboursement | étape 4 depuis Stripe, partiel puis total ; étape 10 en réel, depuis l'administration |
| A5 : export CSV | étape 4 |
| A6, A7 : créer, épuiser, désactiver un produit | étape 4, cinq produits créés puis désactivés ; étape 10, l'article à 1 €, désactivé, sa fiche en 404 depuis `v0.3.24` |
| A8 : modifier une page de contenu | étape 11 : les quatre textes saisis dans l'éditeur, le refus d'un texte à marqueur (`v0.3.25`) |
| A9 : le menu du pied de page | étape 4 : les quatre pages légales ajoutées par Admin → Navigation |

## 6. Décision (point F)

Conditions d'un **go** :

- chaque critère de la section 2 tenu, ou sous une dérogation signée à la
  section 3 ;
- `v0.3.26` publiée (elle porte les corrections de `v0.3.25`, jamais
  taguée), le pilote monté, un nocturne vert — fait le 2026-10-25 (#37,
  `Deploy` 40236611288, nocturne 40237706569) ;
- `v0.3.27` publiée, le pilote monté, un run de l'après-midi vert : la ligne
  RPO.

Les conditions du go (section 5, décisions 4 et 5), que la première boutique
réelle tient avant sa première vente :

- ses pages légales et son parcours d'achat relus par un conseil (fiche,
  section 2) ; ce qu'il demande au socle se corrige dans le socle ;
- la réponse écrite de son expert-comptable aux cinq questions de la fiche
  (section 3), et `invoiceStrategy` qui en dit le résultat (ADR 0010 : sans
  elle, aucune boutique ne passe en production pour vendre) ; une facture
  numérotée ou la franchise en base, si la réponse les demande, se
  construisent dans le socle avant cette vente ;
- sa recette par une personne extérieure, avec le modèle seul, et le
  procès-verbal signé de son commerçant, sans anomalie bloquante.

Ce que la décision dit aussi : ce que devient la boutique `pilote-certif`
(laissée fermée, rouverte avec des clés live pour vendre, ou supprimée par
`shopctl destroy --env production`), et ce qui est promis au premier client
(les limites du plan gratuit, `/mnt/project-files/analyses/limites-tiers-gratuits.md`
dans le projet).

| | |
|---|---|
| Décision | ☐ go ☐ go sous conditions ☐ no-go |
| Conditions, s'il y en a | les trois conditions ci-dessus, tenues par la première boutique réelle avant sa première vente |
| Date | |
| Pour l'agence | |
| Pour le commerçant du pilote | |
