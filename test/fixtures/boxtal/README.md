# Corpus du bac à sable Boxtal

Des réponses réelles de l'API v3 de Boxtal, relevées le 2026-10-30 dans son bac
à sable (`https://api.boxtal.build`) avec l'application de test de l'agence,
pour l'[ADR 0020](../../../docs/architecture/decisions/0020-expeditions-par-boxtal.md)
et le lot 1 du plan (§13.3). Les adaptateurs Boxtal se testent sur ces
fichiers, sans appel réseau : la spécification OpenAPI de Boxtal ne suffit pas.
L'[ADR 0021](../../../docs/architecture/decisions/0021-boxtal-apres-le-bac-a-sable.md)
tire de ces constats ce qui change à l'ADR 0020.

Les fichiers `30` à `39` viennent de l'API v1, celle du devis, sur son serveur
de test (`https://test.envoimoinscher.com/api/v1`), relevés le même jour avec
l'application v1 du même compte. Le corps de leur réponse est le XML tel que
Boxtal l'a rendu, en une chaîne. `40` à `42` reviennent à la v3, pour vérifier
qu'un devis v1 désigne bien une offre v3. `43` à `52`, relevés le même jour
pour le lot 3, y reviennent aussi : le téléphone du destinataire, et ce que
rend une commande tant qu'elle est `PENDING`.

Chaque fichier garde la requête (`method`, `path`, `body`) et la réponse
(`status`, `ms`, `contentType`, `body`), jamais un en-tête : aucune clé n'y
figure. Les parties sont fictives (« Boutique Essai », « Jeanne Essai »,
adresses en `example.com`) ; les points relais sont des commerces publics.
Quatre retouches seulement, après le relevé :

- les URL signées des étiquettes ont `Signature` et `Key-Pair-Id` masqués ;
- les listes de points sont coupées (cinq points, deux par réseau dans `04`),
  et `pointsReturned` donne le nombre de points de la réponse entière ;
- `30` garde trois des 82 natures de contenu, et `contentsReturned` donne
  leur nombre ;
- le corps de `35` est celui de `31`, octet pour octet : il n'est pas recopié,
  `sameBodyAs` y renvoie.

## Les fichiers

| Fichier | Appel | Ce qu'il montre |
|---|---|---|
| `01` | `GET /shipping/v3.2/parcel-point-by-network`, Mondial Relay, 75011 | 30 points, triés par distance |
| `02` | `GET /shipping/v3.2/parcel-point-by-shipping-offer`, `MONR-CpourToi` | les mêmes points que `01`, consignes comprises |
| `03` | même appel, `POFR-ColissimoPickupStation`, 35000 | des réseaux Colissimo plafonnés en poids |
| `04` | `parcel-point-by-network`, trois réseaux, 35000 | 30 points partagés en 10 par réseau |
| `05` | `parcel-point-by-shipping-offer`, code postal `00000` | `200` et une liste vide, pas une erreur |
| `06` | `GET /shipping/v3.1/content-category` | les natures de contenu qu'un colis doit déclarer |
| `10` | `POST /shipping/v3.1/shipping-order`, `POFR-ColissimoAccess` | commande à domicile : `PENDING`, prix hors taxes |
| `11` | même appel, `MONR-CpourToi`, `pickupPointCode` | commande en relais, sans point de dépôt |
| `12` | `GET /shipping/v3.1/shipping-order/{id}` | `CONFIRMED` 14 s après la commande |
| `13`, `15` | `GET …/{id}/shipping-document` | l'étiquette, en URL signée |
| `24` | le même appel que `13`, six minutes plus tard | une autre URL, une autre échéance |
| `14`, `19` | `GET …/{id}/tracking` | numéro, URL de suivi du transporteur, statut |
| `16` | `POST` du corps de `10`, à l'identique | un doublon accepté : nouvelle commande |
| `17` | `POST` vers un point inconnu | `422`, `ValidationException.PickupPointCode` |
| `18` | `GET` d'une commande inconnue | `422`, `ShippingOrderNotFoundException` |
| `20`, `21` | `DELETE …/{id}`, puis `GET` | le doublon annulé : `CANCELLED` |
| `22`, `23` | le suivi de `14` et `19`, 30 minutes plus tard | `SHIPPED`, l'historique allongé |
| `25`, `26`, `27` | `DELETE` des deux commandes une fois `SHIPPED`, puis `GET` | `422`, `InvalidRequestException` : rien n'est annulé |
| `30` | v1, `GET /contents` | les natures de contenu, codes de la v3 |
| `31` | v1, `GET /cotation`, sans filtre | 27 offres de 11 transporteurs, en 8 s |
| `32` | même devis, `offers[N]` : les offres de `10` et `11` | leurs prix, ceux de l'achat |
| `33` | `offers[N]`, huit codes v3 supposés | sept offres : `UPSEEconomyAccessPoint` manque |
| `34` | `operator=MONR` | les deux offres de Mondial Relay |
| `35` | `offers[0]=MONR-CpourToi`, le code v3 | filtre ignoré : la réponse de `31` |
| `36` | sans `code_contenu` | `400`, `bad_request` |
| `37` | code postal `00000` | `200`, les mêmes offres et les mêmes prix |
| `38` | 35 kg vers Rennes | `200` et aucune offre |
| `39` | sans en-tête `Authorization` | `401`, `UnauthorizedException` |
| `40`, `41` | v3, `POST /shipping-order` en `BMON-DomicileFrance`, puis `DELETE` | le prix du devis ; commande annulée |
| `42` | v3, recherche de points en `MONRCpourToi`, sans tiret | `400`, `ValidShippingOfferCode` |
| `43` | v3, `POST /shipping-order` sans téléphone du destinataire | `422`, `ValidationException.Null` |
| `44` | la même commande, avec le téléphone | `PENDING` |
| `45`, `46`, `47` | aussitôt après `44` : suivi, étiquette, `DELETE` | une liste vide ; `422` ; `422` |
| `48` à `52` | 20 s plus tard : la commande, son suivi, son étiquette, `DELETE`, `GET` | `CONFIRMED`, tout est prêt ; puis `CANCELLED` |

## Ce que le bac à sable a établi

**La recherche des points.**

- Une réponse en 0,5 à 1 s.
- Au plus 30 points, triés par distance en mètres. Pour plusieurs réseaux, les
  30 se partagent à parts égales.
- Un code postal inconnu rend `200` et une liste vide : « aucun point » n'est
  pas une panne.
- Un point porte :
  - un code, un nom, une adresse et une position ;
  - ses horaires, jour par jour (une liste vide = fermé) ;
  - ses réseaux compatibles.

  Il ne porte ni téléphone ni fermeture exceptionnelle.
- Les réseaux compatibles disent ce qu'un point accepte :
  - le réseau Mondial Relay mêle points et consignes
    (`MONR_LOCKERS_ONLY_NETWORK`, 14 points sur 30 à Paris 11e) ;
  - Colissimo plafonne par poids (`POFR_UP_TO_10_KG_NETWORK` à
    `POFR_UP_TO_30_KG_NETWORK`), et 5 points sur 30 seulement prennent 30 kg à
    Rennes.

  La boutique filtre donc les points selon le poids du colis.
- **Aucun appel ne relit un point par son code** :
  `/shipping/v3.1/parcel-point` est déprécié et cherche lui aussi.
  - Boxtal valide le point quand l'étiquette s'achète (`17`).
  - Au moment de réserver, la boutique ne peut vérifier qu'une chose : le code
    reçu fait partie des points qu'elle a elle-même servis pour ce code postal
    et cette offre.

**La commande et son prix.**

- `POST /shipping-order` répond en 0,8 à 1,4 s.
- La commande naît `PENDING` et passe `CONFIRMED` en 14 s.
- La réponse donne `deliveryPriceExclTax` : 8,11 € HT en Colissimo Access et
  4,19 € HT en Mondial Relay, pour 0,8 kg.
- **En v3, le prix n'est connu qu'après l'achat** : elle n'a pas de cotation.
- Boxtal renvoie le devis à sa v1 (`GET /cotation`) :
  - une API dépréciée mais maintenue, en XML ;
  - un serveur de test à part, `test.envoimoinscher.com/api/v1` ;
  - les clés d'une application de type v1, distinctes de celles de la v3.

  Elle est relevée plus bas, dans « Le devis v1 ».
- Le compte qui commande est en paiement différé par prélèvement, pas en
  prépaiement (guide `getting-started-api-v3`).

**Le devis v1.**

- `GET /cotation` répond en XML, sur une seule ligne : une liste d'`offer`,
  triée par prix hors taxes croissant. Chaque offre porte :
  - `operator/code` et `service/code` (`MONR`, `CpourToi`), leurs libellés et
    un logo ;
  - `price/tax-exclusive` et `price/tax-inclusive`, en euros décimaux ;
  - `collection` et `delivery` : le mode de remise (`DROPOFF_POINT`,
    `POST_OFFICE`, `COMPANY`) et de livraison (`HOME`, `PICKUP_POINT`), avec
    une date indicative ;
  - `characteristics`, `options` et `mandatory_informations`, qui servent à
    commander en v1. L'achat se fait en v3, qui ne les demande pas (`10`,
    `11`, `40`).
- **Le code d'offre v3 est `<transporteur>-<service>`.**
  - Trois achats en v3 rendent, au centime, le prix hors taxes du devis :
    `POFR-ColissimoAccess` à 8,11 € (`10`), `MONR-CpourToi` à 4,19 € (`11`)
    et `BMON-DomicileFrance` à 6,23 € (`40`, annulé aussitôt en `41`).
  - Onze autres codes formés ainsi passent la validation de la v3 : la
    recherche de points de l'offre les accepte, en arrivée ou en départ
    (`03` et dix recherches faites pour ce relevé).
  - La v3 refuse un code qu'elle ne connaît pas, et le même code sans tiret :
    `400`, `ValidationException.ValidShippingOfferCode` (`42`).

  Le filtre de la v1, lui, colle les deux codes sans tiret :
  `offers[0]=MONRCpourToi`.
- **Un filtre faux ne filtre rien.** Le code v3 `MONR-CpourToi` en `offers[0]`
  est ignoré sans erreur, et la réponse est le devis de tous les transporteurs
  (`35`). L'adaptateur ne garde donc que les offres qu'il a demandées.
- **Le devis se filtre toujours.** Sans filtre, il rend 27 offres et 138 Ko,
  en 8 s au premier appel (`31`). Filtré, il répond en 0,3 à 1,4 s (`32` à
  `34`).
- **Une offre se désigne par le couple.** `DomicileFrance` existe chez `MONR`,
  avec dépôt en point relais (8,10 € HT), et chez `BMON`, « Boxtal Mondial
  Relay », avec enlèvement chez l'expéditeur (6,23 € HT).
- **Une offre impossible manque, sans erreur.** À 35 kg, le devis rend `200`
  et aucune offre (`38`). `UPSEEconomyAccessPoint` manque aussi (`33`), et la
  v3 refuse `UPSE-EconomyAccessPoint` : ce code n'existe pas.
- Le devis ne vérifie pas l'adresse : le code postal `00000` à Paris rend les
  mêmes offres, aux mêmes prix (`37`).
- Le TTC ne se recalcule pas depuis le HT : Boxtal arrondit chacun de son côté
  (4,19 € HT pour 5,02 € TTC, 8,37 € HT pour 10,05 € TTC). La v3 ne rend que
  le HT, et c'est lui que l'achat confirme.
- Les dates partent de `collecte`, le jour même par défaut. L'achat de `10` a
  compté la prise en charge le lendemain : elles restent indicatives.
- Les natures de contenu sont celles de la v3 : `code_contenu=40110` est
  `content:v1:40110` (`30`, `06`). La v1 en a une de plus, `100`, « Contenu
  non spécifié ».
- Un point relais du devis porte le code du transporteur : `MONR-41132` en v1,
  `41132` en v3, le même point.
- Les erreurs :
  - un paramètre manquant rend `400`, `<error><code>bad_request</code>` et un
    message en français (`36`), comme la spécification le dit ;
  - sans authentification, `401` et `<UnauthorizedException>`, une autre forme
    que celle de la spécification (`39`).
- Les libellés de `mandatory_informations` sont échappés deux fois
  (`l&amp;apos;envoi`). Ceux des transporteurs, des services et des options
  ne le sont pas.

**Avant `CONFIRMED`.**

- Le téléphone du destinataire est obligatoire : sans lui, la commande rend
  `422` et `ValidationException.Null` sur `shipment.toAddress.contact.phone`
  (`43`). La boutique ne le demande pas encore à l'acheteur : jusqu'au lot 4,
  le commerçant le saisit dans la fiche commande.
- Tant que la commande est `PENDING`, Boxtal ne rend presque rien d'elle :
  - son suivi : `200` et une liste vide (`45`) ;
  - son étiquette : `422` et `UnexpectedException` (`46`) ;
  - son annulation : `422` et `PrivateServiceException` (`47`), et rien n'est
    annulé.
- 20 s plus tard, elle est `CONFIRMED` : le suivi rend le numéro, l'URL et la
  référence du colis (`49`), l'étiquette est prête (`50`), et la commande
  s'annule (`51`, `52`).
- La boutique enregistre donc l'achat dès la réponse, puis relit le suivi :
  c'est lui qui porte le numéro et la référence du colis.

**Pas d'idempotence, pas de liste.**

- Le même corps renvoyé crée une seconde commande (`16`), même avec les mêmes
  `externalId` d'expédition et de colis.
- Aucun appel ne liste les commandes, ni ne cherche par `externalId`.
- Une commande se relit par son identifiant Boxtal. Elle ne rend pas
  l'`externalId`, mais son suivi rend `packageExternalId` (`14`).
- Une commande se défait par `DELETE` (`20`), mais seulement avant que le
  transporteur ait pris le colis. Une fois `SHIPPED`, le `DELETE` rend `422`
  et un `InvalidRequestException` sans détail, et la commande reste
  `CONFIRMED` (`25` à `27`). Un doublon s'annule donc vite, ou se paie.

  Ce qu'un envoi réel annulé coûte reste à voir sur le compte réel. Dans le bac
  à sable, rien n'est facturé, et les deux commandes de `22` et `23` y restent.

**L'étiquette.**

- `shipping-document` donne une URL signée sur `document.boxtal.build`,
  valable 31 jours.
- Chaque lecture en signe une nouvelle : une seconde lecture, six minutes plus
  tard, a rendu une autre URL, avec une autre échéance.
- Le document est prêt dès `CONFIRMED` dans le bac à sable ; le webhook
  `DOCUMENT_CREATED` l'annonce.
- `PDF_10x15` demandé, `PDF_A4` rendu : un PDF de 3 466 octets, au format A4.

**Le suivi.**

- Le numéro et l'URL de suivi du transporteur arrivent dès la commande :
  - `laposte.fr/outils/suivre-vos-envois?code=…` pour Colissimo ;
  - `mondialrelay.com/public/permanent/tracking.aspx?ens=…&exp=…` pour Mondial
    Relay.
- Le statut naît `ANNOUNCED` (« Envoi préparé ») ; 30 minutes plus tard, les
  deux colis étaient `SHIPPED` (`22`, `23`).
- Le bac à sable promet un faux événement toutes les 20 minutes. Il en a
  produit toutes les 10 minutes pour Colissimo : cinq événements, dont
  `IN_TRANSIT`.
- L'historique va du plus récent au plus ancien. Deux événements peuvent
  partager la même seconde : `SHIPPED` y est listé avant `IN_TRANSIT`, et c'est
  lui que le statut de tête reprend. Le rang d'un statut ne dit donc pas
  l'ordre des faits : la boutique lit le statut de tête et `isFinal`, sans
  trier.
- La spécification énumère neuf statuts : `ANNOUNCED`, `SHIPPED`,
  `IN_TRANSIT`, `OUT_FOR_DELIVERY`, `FAILED_ATTEMPT`,
  `REACHED_DELIVERY_PICKUP_POINT`, `DELIVERED`, `RETURNED` et `EXCEPTION`.
- `trackingDateTime` est l'heure de Paris, sans fuseau : `16:40:03` pour un
  relevé fait à 15 h 40 UTC. Les dates de Mondial Relay sont fictives
  (`08:00:00`, `10:00:00`).
- `location` est parfois rempli (« Centre Courrier 34 »), parfois `null`.

**Le webhook.**

- La signature `x-bxt-signature` est un HMAC SHA256 du corps seul, sans
  horodatage : un appel rejoué passe la vérification. Le webhook n'étant qu'un
  signal que la boutique vérifie en relisant, cela ne change rien.
- Une souscription ne reçoit que les événements des commandes de sa propre
  application.
- Pas essayé ici : il faut une URL publique.

## Ce qui reste ouvert

- La remise d'un colis Mondial Relay commandé sans `dropoffPointCode` (`11`) :
  dépôt dans n'importe quel point, ou enlèvement ? À établir sur le compte réel.
- Les consignes : l'offre `MONR-CpourToi` les propose (`02`). Un colis de
  30 × 20 × 10 cm y entre-t-il, et faut-il les écarter ?
- Le format `PDF_10x15` : est-ce le bac à sable seul qui rend du A4 ?
- Ce que coûte une commande réelle annulée avant la prise en charge.
- Le webhook, de bout en bout, sur une boutique déployée.
- Le devis sur le compte réel : ses prix restent-ils ceux de l'achat ?
