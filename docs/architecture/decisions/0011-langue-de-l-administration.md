# ADR 0011 — Langue de l'administration

- **Statut** : Remplacé par [ADR 0018](0018-administration-en-francais.md)
- **Date** : 2026-08-30
- **Jalon** : 3

## Contexte

Le jalon 3 rend le socle français et demande explicitement de trancher « la
traduction de l'admin ». La question se pose parce que les deux surfaces n'ont
ni le même public ni le même volume.

Le **storefront** s'adresse à un consommateur français. Sa langue est une
obligation, pas une préférence : les CGV, les mentions légales, le prix TTC et
le tunnel de commande sont lus par quelqu'un qui n'a pas choisi de lire de
l'anglais.

L'**administration** s'adresse à l'exploitant. Dans le modèle du pilote, c'est
l'agence qui exploite (ADR 0002) : provisioning, catalogue, remboursements,
étiquettes de transport, sauvegardes. Le commerçant y entre pour les réglages et
les commandes.

Le volume n'est pas comparable. Le catalogue français couvre aujourd'hui
193 clés pour tout le parcours d'achat, les e-mails et les erreurs. L'admin,
c'est une trentaine de pages, des formulaires de réglages, des libellés de
statut, des messages d'erreur d'API et des colonnes de tableaux — de l'ordre de
plusieurs centaines de chaînes supplémentaires, pour une surface qui change à
chaque jalon.

Une contrainte technique s'y ajoute. Les pages `/payment-setup` et les
libellés de secrets renvoient à des écrans nommés en anglais dans le produit
(« Admin → Settings → Payment keys »), et les fournisseurs (Stripe, Resend,
Cloudflare, Shippo) présentent eux-mêmes leurs tableaux de bord en anglais. Une
traduction partielle produit des instructions qui nomment en français des
boutons qui n'existent qu'en anglais.

## Décision

**L'administration reste en anglais pour le pilote.** `AdminLayout.astro`
conserve `lang="en"`, délibérément différent du storefront, et le
`<html lang>` du storefront est dérivé de `LOCALE` (`features/i18n/locale.ts`).
Un `lang` faux est pire qu'un `lang` étranger : il fait lire le document par une
synthèse vocale avec la mauvaise prononciation et déclenche la traduction
automatique sur des mots qui n'en demandent pas.

**Ce qu'un client peut atteindre est français, même si l'admin ne l'est pas.**
La frontière n'est pas « admin / storefront » mais « qui lit ». `/payment-setup`
est une page d'aide destinée au commerçant, atteignable depuis le panier : sa
prose est française et nomme en anglais les écrans qui portent ces noms.

**Les données restent formatées avec la locale de la boutique, partout.**
`formatPrice()` et `formatDate()` sont uniques ; l'admin affiche donc
`1 234,56 €` et `15 janvier 2026` même en anglais. Une date au format américain
dans un back-office français est une source d'erreur d'exploitation, pas une
question de langue.

**Rien n'est bloqué.** Les chaînes de l'admin ne passent pas par `t()`
aujourd'hui, mais le catalogue est typé et la clé est le point d'appel : traduire
l'admin plus tard consiste à ajouter des clés et à remplacer des littéraux, sans
toucher à l'architecture. Le compilateur signalera les manques (voir
`test/i18n/catalog-typing.test.mjs`).

## Conséquences

- l'effort du jalon 3 va au parcours qui a une obligation légale de langue ;
- le storefront et l'admin déclarent deux `lang` différents dans un même
  déploiement, ce qui est correct et doit le rester ;
- un commerçant qui exploite lui-même sa boutique voit une administration
  anglaise. C'est un coût assumé, à réévaluer quand une boutique du pilote sera
  exploitée sans l'agence — pas avant ;
- traduire l'admin plus tard ne rouvre pas cette décision : elle porte sur le
  périmètre du pilote, pas sur une impossibilité.

## Alternatives écartées

- **Traduire l'admin dans le même jalon** : multiplie par plusieurs fois la
  surface de traduction, dans la partie qui change à chaque jalon, au bénéfice
  d'un public qui est l'agence elle-même. Le jalon 3 y perdrait ce que le
  storefront doit gagner.
- **Traduire partiellement (réglages et commandes seulement)** : produit une
  interface où la moitié des libellés change de langue selon l'écran, et des
  instructions françaises qui nomment des boutons anglais.
- **Suivre l'`Accept-Language` du navigateur dans l'admin** : rendrait la même
  page différente pour deux exploitants, donc irreproductible en support — « le
  bouton en haut à droite » cesse d'être une désignation partagée.
- **Mettre `lang="fr"` sur une admin anglaise** : coûte zéro et casse la
  synthèse vocale et la traduction automatique. Un `lang` est une affirmation
  sur le contenu, pas un réglage régional.
