# Exploitation d'une boutique

Ce dossier est ce qu'un opérateur ouvre quand quelque chose ne va pas, et ce
que l'agence remet au commerçant qui s'en va. Chaque procédure est écrite pour
être suivie à froid, commande par commande ; elle est corrigée d'après ce qui
s'est réellement passé la première fois qu'on l'a exécutée (étape 8 de la
certification).

## Runbooks d'incident

| Incident | Runbook |
|---|---|
| Le Worker répond en erreur, ou un quota du plan gratuit est atteint | [worker-en-erreur](runbooks/worker-en-erreur.md) |
| Stripe ne livre plus les webhooks | [webhooks-stripe](runbooks/webhooks-stripe.md) |
| Les e-mails ne partent plus | [emails-bloques](runbooks/emails-bloques.md) |
| La base est corrompue ou perdue | [base-corrompue](runbooks/base-corrompue.md) |
| Un secret a fuité | [fuite-de-secret](runbooks/fuite-de-secret.md) |
| Des données personnelles ont été exposées | [violation-de-donnees](runbooks/violation-de-donnees.md) |
| Le mot de passe d'administration est perdu | [mot-de-passe-admin](runbooks/mot-de-passe-admin.md) |

Et une procédure qui n'est pas un incident : le [départ d'un client](sortie-client.md).

Trois règles valent pour tous :

- **revenir d'abord, comprendre ensuite.** Un retour arrière du Worker, une
  désactivation du panier, une révocation de jeton se font en minutes ;
  l'enquête attend qu'ils soient faits ;
- **rien de personnel dans le suivi.** Un ticket, un message ou une capture ne
  portent pas d'adresse ni d'e-mail d'acheteur : un identifiant public de
  commande suffit ;
- **chaque incident laisse une note datée** dans le registre d'incidents de la
  boutique : détection, retour, cause, mesures. C'est aussi le registre des
  violations qu'exige l'article 33 du RGPD quand des données sont en cause.

## Supervision

### Décision (2026-10-06, étape 0 de la certification)

Le catalogue des notifications Cloudflare ne propose **aucune alerte** sur le
taux d'erreur d'un Worker, son temps CPU ou les quotas D1 aux plans sur
lesquels tourne une boutique : les plus proches, « Usage Based Billing » et
« Origin Error Rate », demandent respectivement un plan Pro ou supérieur et un
contrat Enterprise. Ce que tous les plans ont, c'est l'API GraphQL Analytics.

La supervision est donc une commande du socle, lancée chaque nuit :

```sh
npm run shopctl -- monitor --env production            # plan gratuit
npm run shopctl -- monitor --env production --plan paid
```

Elle échoue (code 6) quand :

- plus de 1 % des invocations du Worker se terminent en erreur sur les
  dernières vingt-quatre heures (jugé à partir de cent requêtes) ;
- au plan **Workers Free**, 70 % d'un quota quotidien est atteint : 100 000
  requêtes, 5 millions de lignes D1 lues, 100 000 écrites. Au-delà de ces
  quotas, la boutique répond en erreur jusqu'à minuit UTC ; l'alerte sonne
  donc le jour où le commerçant doit **passer au plan Workers Paid**, pas le
  jour du blocage ;
- au plan **Workers Free**, Cloudflare a arrêté une invocation pour ses
  limites (erreur 1102 pour le visiteur). Les 10 ms de CPU par requête se
  jugent ainsi, et non sur le p99, qui est relevé sans être jugé : Cloudflare
  tolère un dépassement occasionnel par isolat, et le p99 d'une petite
  boutique, ce sont ses démarrages à froid, qui dépassent toujours (rouge
  chaque nuit sur le staging de la certification sans qu'aucune requête ait
  été arrêtée — étape 6, 2026-10-15).

Une analytique injoignable ou refusée est un échec (code 5), jamais un vert.

Le workflow `Nightly` la lance sur staging avec le jeton de l'environnement, et
sur la production avec un jeton à part, en lecture seule (« Account
Analytics : Read » et « D1 : Read »), posé en secrets du dépôt
`MONITOR_CLOUDFLARE_API_TOKEN` et `MONITOR_CLOUDFLARE_ACCOUNT_ID` : l'environnement
`production` porte des relecteurs obligatoires qui retiendraient le run chaque
nuit, et un jeton de déploiement qui peut écrire. Sans ce secret, le job le dit
dans un avertissement plutôt que de passer.

Le run nocturne qui échoue est une notification que GitHub envoie déjà ; il n'y
a pas de second canal à entretenir.

### Ce qui reste manuel

- **Notifications du compte Cloudflare** : abonner l'adresse de l'opérateur et
  celle du commerçant aux notifications disponibles sur le compte (facturation,
  incidents de la plateforme), et à « Usage Based Billing » si le plan le
  permet ;
- **Stripe** : il prévient par e-mail quand un endpoint de webhook échoue de
  façon répétée ; vérifier que l'adresse du compte est lue ;
- **Resend** : les rebonds et les plaintes se lisent dans son tableau de bord.

La première exécution réelle de `shopctl monitor` (étape 8) dira si les champs
de l'API sont ceux que la doublure suppose ; la commande échoue bruyamment dans
le cas contraire.
