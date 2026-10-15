# Étape 5 — Sécurité sur la boutique déployée

Passée les 2026-10-14 et 2026-10-15 sur le staging de `pilote-certif`
(compte A), monté en `v0.3.4`, selon la fiche
`docs/certification/etape-5-commandes.md` du socle. Stripe en mode test,
e-mails réels vers une boîte de test, requêtes hostiles vers la seule preview,
avec un jeton de service Access créé pour l'étape puis révoqué.

## Les lignes de l'étape

| Ligne                                         | Preuve                                                                                     | Résultat                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| les neuf lignes du §8.4 contre le staging     | `porte-distante.txt`, `porte-distante-limiteurs.txt`, `diag-limiteur.txt`, `diag-limiteur-lourd.txt` | 15 contrôles sur 15 ; les trois limiteurs ne répondent pas 429 dans le budget de la porte : **ligne ouverte**, voir « Défauts » 1                                                     |
| `wrangler tail` pendant l'achat et la porte   | `journaux.json`, la trace ci-dessous                                                       | 531 événements, sans échantillonnage : rien dans ce que la boutique écrit ni dans les URL                                                                                                    |
| `npm audit` racine et `mcp/`                  | `audit-racine.json`, `audit-mcp.json`                                                      | zéro vulnérabilité, toutes sévérités, outils de développement compris                                                                                                                       |
| scan de secrets, historique, artefacts, nocturne | `historique-v0.3.4.txt`, `historique-regle-corrigee.txt`, `nightly.txt`                  | arbre et build verts ; l'historique, rouge sur un faux positif du socle (« Défauts » 4), vert avec la règle corrigée ; ni secret ni adresse dans les deux `Nightly` d'après la montée      |

## La montée

`socle/v0.3.4` fusionnée par la pull request #10 (CI 20/20), puis
`deploy-v0.3.4.json` : `ok`, le compte A sous le nom `<email>'s Account`, test
de fumée vert, migration 0043 appliquée. Deux `npm run verify` rouges avant ce
rapport, lancés par `deploy` sans rien téléverser (« Défauts » 2 et 3).

`NIGHTLY_EMAIL_TO` était encore une variable de l'environnement staging, que
le `Nightly` de `v0.3.4` aurait écrite en clair : copiée en secret sans être
affichée, puis la variable supprimée, comme le demande `docs/migrations/v0.3.4.md`.

## La commande E

| Commande         | `pi_…`                        | Montant | Ce qui a été vu                                                                                                                                                                                 |
| ---------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ord_p316t3nf6h` | `pi_3UQk6dPDgQeHL5O71fcUM5x0` | 13,40 € | baume à lèvres, Colissimo 5,90 €, TVA 2,23 € ; confirmation et alerte ; remboursement de 2,00 € depuis Stripe et son e-mail ; expédiée en Colissimo, suivi fictif, e-mail avec lien de suivi ; e-mail de test des réglages |

Nom et adresse de Stripe : un nom et une adresse inventés, que le relevé a
cherchés dans la capture (`PII_NEEDLES`, par l'environnement). `commande-e.json`
reprend la ligne en base, sans `email` ni `ship_address`.

Téléversements dans l'administration : le faux PNG et le PNG de plus de 5 Mo
refusés, avec les messages attendus sur le type et sur la taille ; une vraie
photo acceptée, puis supprimée. Une image du catalogue, demandée en `HEAD` :

```
HTTP/2 200
content-type: image/png
x-content-type-options: nosniff
```

## Le relevé et la trace

`journaux.json` : 531 événements, toutes issues `ok`, aucun `overload`.

- **Ce que la boutique a écrit** : trois lignes. Deux `unhandled_error` sur
  `POST /api/cart`, le 500 que la porte provoque exprès (un corps
  `application/octet-stream`), au message générique ; une exception sur un
  `HEAD` d'image (« Défauts » 5). Ni adresse, ni jeton, ni secret, ni le nom ni
  la rue inventés.
- **Les URL** : 526 requêtes, rien. Les jetons de `/order/<jeton>` sont masqués
  par la plateforme.
- **En-têtes et métadonnées** : `cf-access-jwt-assertion` et
  `cf-access-authenticated-user-email` arrivent déjà `REDACTED` dans la
  capture, masqués par la plateforme. Les valeurs hexadécimales de
  `cf.tlsExportedAuthenticator` sont rapportées par le relevé comme
  métadonnées de la plateforme, sans être jugées.

La trace du `POST /api/webhook` qui a enregistré E, dans Observability (compte
A) : les réglages lus, l'option de livraison demandée à Stripe
(`/v1/shipping_rates/REDACTED`, masqué par la plateforme), la réservation lue,
le `batch` qui écrit la commande, puis les notifications et les deux envois à
Resend (`/emails`). Chaque requête D1 y figure par son texte, paramètres en
`?` : ni le nom, ni la rue, ni l'adresse e-mail dans ses attributs. Celle de
10:30:50, ouverte d'abord, est la libération d'une réservation abandonnée
(`UPDATE products SET stock = stock + ?`) : rien non plus.

Pour l'étape 6 : chaque requête D1 de ces traces prend 170 à 220 ms, et le
webhook en enchaîne une vingtaine.

## Ce qui était déjà publié

Les deux `Nightly` d'après la montée (38705481020, programmé, et 38708177599,
lancé pour l'étape) : journaux et artefacts relus, aucune adresse ; l'e-mail
de test part vers `<destinataire>`. Leur job de staging est rouge pour l'étape
6 : la porte navigateur (une violation WCAG sur la page de contenu) et le CPU
p99 (37,9 ms pour 10 ms).

Les journaux des trois `Nightly` d'avant la montée (38455159960, 38466884657,
38537925534) et leurs quatre artefacts sont supprimés : ils portaient
l'adresse de connexion à Cloudflare, et les premiers l'adresse de test. Les
runs restent, avec la couleur de leurs jobs ; 38455159960, que l'étape 3 cite,
est archivé hors du dépôt chez l'opérateur. Les cinq rapports de l'étape 3
sont masqués par ce commit ; l'historique les garde.

## Fichiers

| Fichier                        | Section de la fiche                                                         |
| ------------------------------ | --------------------------------------------------------------------------- |
| `deploy-v0.3.4.json`           | 1 — déploiement de la montée                                                |
| `historique-v0.3.4.txt`        | 2 — `check:secrets:history`, le faux positif                                |
| `historique-regle-corrigee.txt` | 2 — le même historique, scanner de la correction du socle : vert           |
| `audit-racine.json`, `audit-mcp.json` | 3 — `npm audit` complet                                              |
| `porte-distante-limiteurs.txt` | 5 — premier passage, `--limiteurs` : les trois limiteurs en échec           |
| `diag-limiteur.txt`            | 5 — 232 recherches une par une en 70 s : aucune refusée                     |
| `diag-limiteur-lourd.txt`      | 5 — 1 000 recherches, 50 en parallèle : 325 refusées, la première après ~450 |
| `porte-distante.txt`           | 5 — second passage sous la capture, sans `--limiteurs` : 15 sur 15          |
| `commande-e.json`              | 6 — la commande E en base                                                   |
| `journaux.json`                | 7 — relevé de la capture                                                    |
| `nightly.txt`                  | 8 — le `Nightly` d'après la montée                                          |

## Défauts trouvés en réel

1. **Les limiteurs de débit sont actifs mais très permissifs.** Les liaisons
   sont sur la version déployée et le code passe par elles, sans erreur. Mais
   la porte n'obtient aucun 429 en trois fois la limite, tirée par rafales de
   dix ; 232 recherches une par une en 70 s passent toutes, pour une limite de
   60 par minute ; 1 000 recherches, 50 en parallèle, donnent un premier 429
   après environ 450, puis sept refus sur dix. Cloudflare documente ce limiteur
   comme permissif, compté par localisation et mis en cache par machine. La
   recherche et le checkout gardent une protection contre l'inondation ; la
   connexion à l'administration, sans Access en production, ne freine pas un
   essai patient. Décision : un compteur exact des échecs de connexion dans le
   socle, et la porte recalibrée, en `v0.3.5` ; la ligne reste ouverte jusque-là.
2. **`deploy` rouge dans le shell de la fiche.** La fiche exporte
   `CLOUDFLARE_ACCOUNT_ID` ; le test de `shopctl new`, lancé par
   `npm run verify`, en hérite, et le manifeste qu'il compare porte alors un
   `accountId`. Contourné en lançant `deploy` sans la variable : `shopctl`
   épingle le compte depuis le manifeste.
3. **Test du scaffold sensible à `core.autocrlf`.** Son dépôt témoin n'a pas
   de `.gitattributes` : avec `core.autocrlf=true` sur le poste, le clone rend
   un fichier en CRLF. Contourné par `GIT_CONFIG_*` pour le seul processus de
   `deploy`.
4. **Faux positif dans l'historique du socle.** Un JWT d'exemple d'un test du
   socle (blob `1d72246df3`, commit `cfada29`), retiré de l'arbre depuis :
   en-tête `{"alg":"RS256"}`, charge `{"sub":"operator"}`, signature « sig ».
   Aucune vraie signature ne fait moins de 43 caractères. Toute boutique en
   `v0.3.4` le porte, le socle aussi ; l'historique publié ne se récrit pas.
5. **Une exception à chaque `HEAD` d'image.** Astro répond au `HEAD` par le
   gestionnaire `GET`, qui met la réponse en cache ; l'API Cache refuse une
   requête autre que `GET` (« Cannot cache response to non-GET request »). La
   réponse reste un 200 correct ; l'exception va dans les journaux.

Ces défauts sont corrigés dans le socle et livrés par une montée de version.
