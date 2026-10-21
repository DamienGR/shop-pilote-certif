# Runbook — mot de passe d'administration perdu

**Déclencheur** : le commerçant ne peut plus se connecter à `/admin` et n'a
pas d'autre accès (pas d'application Access devant l'admin).

Il n'y a pas de « mot de passe oublié » public, et il n'y en aura pas : un lien
de réinitialisation est une porte de plus sur l'admin (invariant 5). La
réinitialisation passe par l'accès au compte Cloudflare, que seul le
propriétaire et ses opérateurs ont.

## D'abord : bloqué n'est pas perdu

Si la page de connexion répond « Trop de tentatives échouées », le mot de passe
n'est peut-être pas perdu : le réseau du commerçant a épuisé ses cinq essais du
quart d'heure (`src/features/auth/loginThrottle.ts`, table
`admin_login_attempts`). Le compteur est par réseau client, pas par mot de
passe : une réinitialisation ne le remet pas à zéro, la fin du quart d'heure si.
Attendre, puis essayer une seule fois, posément.

S'il faut débloquer tout de suite, et seulement pour le commerçant dont
l'identité a été vérifiée comme plus bas :

```sh
npx wrangler d1 execute minshop-<slug>-production-db --remote --command "DELETE FROM admin_login_attempts"
```

Un blocage qui revient alors que le commerçant n'essaie rien veut dire que
quelqu'un essaie depuis le même réseau (une box partagée, l'adresse commune
d'un opérateur mobile) : c'est un incident, pas une gêne.

## Ce que fait la réinitialisation

`shopctl admin password` pose le nouveau haché directement dans la base de
l'environnement, calculé par le module du Worker
(`src/features/auth/password.ts`) et relu avant que la commande ne dise qu'elle
a réussi. La boutique ne repasse jamais en mode amorçage : `/admin/setup` ne
s'ouvre à personne pendant l'opération.

Le mot de passe se lit sur l'entrée standard, jamais en argument : saisi deux
fois sans écho dans un terminal, ou depuis un fichier. Il fait huit caractères
au moins, le minimum de l'assistant.

`scripts/admin-reset.sh`, qui supprimait la ligne et rouvrait l'assistant à
tout le monde jusqu'à la saisie, n'est plus la procédure : la fenêtre qu'il
ouvrait n'avait que « tout de suite » pour garde (étape 9 de la
certification, 2026-10-20).

## Procédure

1. Convenir avec le commerçant du canal par lequel il recevra le nouveau mot de
   passe : un autre que celui de la demande (un appel s'il a écrit, un SMS
   s'il a appelé). L'opérateur le connaît, ce qui ne lui donne rien de plus que
   ce que le compte Cloudflare lui donne déjà ; l'admin n'a pas encore d'écran
   pour en changer, et un second passage de cette commande, à la demande du
   commerçant, est la seule façon de le remplacer.
2. Depuis l'arbre de la boutique, avec le compte de l'environnement :

   ```sh
   npm run shopctl -- admin password --env production
   ```

   La commande vérifie le compte comme les autres (le manifeste, `--account`,
   `CLOUDFLARE_ACCOUNT_ID`), rend `wrangler.jsonc` pour l'environnement visé,
   puis demande le mot de passe deux fois.

3. Vérifier : la connexion aboutit sur `/admin/login`, et `/admin/setup`
   redirige toujours vers `/admin/login`.

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<domaine>/admin/setup
```

Toutes les sessions d'administration ouvertes avec l'ancien mot de passe
tombent : la session est liée au haché.

Sur un staging, le mot de passe est aussi le secret d'environnement GitHub
`MINSHOP_ADMIN_PASSWORD`, avec lequel le contrôle d'e-mail du `Nightly` se
connecte : le remplacer dans la foulée, sans quoi le run suivant est rouge.

## Après

Une note dans le registre d'incidents : qui l'a demandé, par quel canal, et
comment l'identité du demandeur a été vérifiée. Une réinitialisation demandée
par quelqu'un qui n'est pas le commerçant est une tentative de prise de
contrôle, pas un ticket de support.

`wrangler.jsonc` est resté rendu pour l'environnement visé, avec ses vrais
identifiants : `git restore wrangler.jsonc` remet le rendu versionné, sans
compte, avant tout commit (étape 8 de la certification).
