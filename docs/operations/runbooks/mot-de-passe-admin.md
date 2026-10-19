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

## Ce que fait la réinitialisation, et le risque qu'elle ouvre

`scripts/admin-reset.sh` supprime la ligne `admin_password_hash` : la boutique
repasse en **mode amorçage**, et `/admin/setup` redevient accessible **sans
authentification** jusqu'à ce qu'un nouveau mot de passe soit posé. Cette
fenêtre doit durer quelques secondes, pas une nuit.

## Procédure

1. Prévenir le commerçant de l'heure exacte, et qu'il doit être prêt à saisir
   son nouveau mot de passe dans la minute.
2. Depuis l'arbre de la boutique, rendre la configuration de l'environnement
   visé — `admin-reset.sh` écrit dans la base que nomme le `wrangler.jsonc`
   présent, et un fichier laissé par l'autre environnement l'enverrait ailleurs :

   ```sh
   npx wrangler d1 list   # relever l'identifiant de minshop-<slug>-production-db
   node scripts/prepare-client.mjs <slug> --env production --database-id <uuid>
   ```

3. Réinitialiser, puis ouvrir aussitôt `/admin/setup` sur le domaine de
   production et poser le nouveau mot de passe (huit caractères au moins) :

   ```sh
   scripts/admin-reset.sh --remote
   ```

4. Vérifier : `/admin/setup` redirige maintenant vers `/admin/login`.

```sh
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://<domaine>/admin/setup
```

Toutes les sessions d'administration ouvertes avec l'ancien mot de passe
tombent : la session est liée au haché.

## Après

Une note dans le registre d'incidents : qui l'a demandé, par quel canal, et
comment l'identité du demandeur a été vérifiée. Une réinitialisation demandée
par quelqu'un qui n'est pas le commerçant est une tentative de prise de
contrôle, pas un ticket de support.
