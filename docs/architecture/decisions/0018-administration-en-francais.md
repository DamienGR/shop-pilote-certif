# ADR 0018 — L'administration en français

- **Statut** : Accepté
- **Date** : 2026-10-16
- **Jalon** : 10 (avant la recette de l'étape 11)
- **Remplace** : [ADR 0011](0011-langue-de-l-administration.md)

## Contexte

L'[ADR 0011](0011-langue-de-l-administration.md) gardait l'administration en
anglais pour le pilote : c'est l'agence qui exploite (ADR 0002), la surface est
plusieurs fois celle du storefront et change à chaque jalon, et une traduction
partielle aurait nommé en français des boutons restés anglais. Il prévoyait
d'être réévalué, et notait que rien n'était bloqué : le catalogue est typé, la
clé est le point d'appel.

Deux faits changent la balance pendant le jalon 10 :

- le commerçant entre dans l'administration pour les réglages et les commandes,
  et la recette de l'étape 11 est faite par une personne extérieure au
  développement, sur l'interface qui sera livrée. Une recette passée sur une
  administration anglaise serait à refaire au moment de la traduire ;
- la documentation de support du §12 nomme les écrans de l'administration. Elle
  s'écrit maintenant : l'écrire sur des noms anglais, c'est l'écrire deux fois.

Le 2026-10-16, Damien a tranché pour le français seul, dans la version du
socle qui suit l'étape 6.

Deux arguments de l'ADR 0011 restent vrais et structurent cette décision : une
administration à moitié traduite est pire qu'une administration anglaise, et un
`lang` qui ment sur le contenu est pire qu'un `lang` étranger.

## Décision

**Toute l'administration est en français, et seulement en français.** Elle
parle la langue unique de la boutique, `LOCALE` (`features/i18n/locale.ts`) :
pas de réglage de langue de l'administration, pas d'`Accept-Language`.
`AdminLayout.astro` déclare `lang={LANG}`, comme le storefront.

**Un seul catalogue, un seul `t()`.** Les chaînes de l'administration vivent
dans `src/features/i18n/admin/`, un fragment par section (commandes, réglages,
livraison…), toutes leurs clés préfixées `admin.`, et `messages.ts` les étale
dans `fr`. Une clé absente est une erreur de compilation, et la typographie
française (apostrophe typographique, espace fine insécable avant `? ! ; :`)
est vérifiée sur l'administration comme sur le storefront.

**La frontière « qui lit » est conservée.** Une phrase que l'exploitant lit est
en français, y compris une note que l'administration enregistre pour la lui
réafficher plus tard (le motif d'un remboursement, l'échec d'un achat
d'étiquette). Un identifiant lu par une machine reste anglais : colonnes de
l'export CSV des commandes, clés du manifeste, valeurs d'énumération stockées
en D1, noms de champs, paramètres d'URL, et le JSON des API publiques. Les
journaux ne sont pas une interface : leurs événements et leurs champs restent
des identifiants anglais, et leurs messages ne sont pas traduits pour
eux-mêmes. Une note enregistrée avant la mise à niveau garde la langue dans
laquelle elle a été écrite.

**Les écrans des fournisseurs gardent leurs noms.** Stripe, Resend,
Cloudflare ou Shippo présentent leurs tableaux de bord en anglais :
« Developers → Webhooks » reste en anglais parce que c'est le bouton sur
lequel l'exploitant clique là-bas. Les écrans de minshop, eux, se nomment en
français dans la documentation, tels qu'ils s'affichent (« Admin → Réglages →
Paiements »).

## Conséquences

- une boutique qui monte vers la version portant ce changement voit son
  administration changer de langue d'un coup ; ses runbooks et la page d'aide
  `/payment-setup` changent dans le même commit ;
- les fiches de certification déjà jouées (étapes 2 à 6, jusqu'à `v0.3.6`)
  gardent les noms anglais : elles décrivent la version sur laquelle elles ont
  été jouées. Les fiches suivantes nomment les écrans en français ;
- le catalogue grossit des chaînes de l'administration, côté serveur seulement :
  aucun script client n'importe `t()` (les chaînes leur arrivent par un attribut
  `data-*` ou `define:vars`), donc le JavaScript du storefront ne change pas ;
- une deuxième locale (ADR 0008) devra traduire aussi l'administration :
  `LocaleCatalog` en contient les clés. C'est cohérent, une deuxième locale
  étant déjà une décision de version de schéma ;
- un membre de l'agence qui ne lit pas le français lit une administration
  française. C'est un coût assumé.

## Alternatives écartées

- **Une administration bilingue réglable par boutique** : deux catalogues à
  tenir pour la surface qui change à chaque jalon, chaque runbook et chaque
  capture en deux versions, et le défaut que l'ADR 0011 reprochait à
  l'`Accept-Language` sous une forme atténuée : deux boutiques, deux noms pour
  le même bouton en support.
- **Garder l'anglais jusqu'après le pilote** : la recette extérieure et la
  documentation de support porteraient sur une interface appelée à changer
  juste après la décision go/no-go.
- **Traduire d'abord les réglages et les commandes** : écarté par l'ADR 0011
  pour une interface qui change de langue d'un écran à l'autre, et toujours
  écarté.

## Vérification

- `src/features/i18n/messages.test.ts` : la typographie de chaque valeur, le
  préfixe `admin.` de chaque clé de l'administration, aucune clé définie dans
  deux fragments ;
- `test/i18n/admin-language.test.mjs` : aucune page de l'administration ne
  déclare `lang="en"`, et aucun gabarit de l'administration ne contient une
  phrase anglaise écrite en dur ;
- `npm run check` : une clé absente du catalogue ne compile pas.
