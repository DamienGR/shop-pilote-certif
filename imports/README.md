# Imports de pilote-certif

Les sources du catalogue de cette boutique : le CSV produit et les médias qu'il
référence. Rien ici n'est lu à l'exécution — l'import écrit dans D1 et R2, et
c'est la boutique déployée qui sert le résultat.

    shopctl catalog validate ./imports/catalog.csv
    shopctl catalog import ./imports/catalog.csv --dry-run
    shopctl catalog import ./imports/catalog.csv

## Une ligne, une unité vendue

Un produit simple tient sur une ligne : sa référence est dans `sku`, la colonne
`variant` reste vide. Un produit à variantes occupe une ligne par variante :
chacune a sa propre référence dans `sku`, toutes portent la référence du produit
parent dans `product`, et les colonnes de portée « produit » ne se renseignent
qu'une fois — les répéter à l'identique est toléré, les contredire est refusé.

| Colonne | Portée | Rôle |
| --- | --- | --- |
| `sku` | unité | Référence de l'unité vendue. Identité de l'import : c'est sur elle que la reprise et le réimport se reconnaissent. |
| `product` | unité | Référence du produit parent, pour regrouper les lignes d'un produit à variantes. Vide pour un produit simple. |
| `name` | produit | Nom affiché. Obligatoire sur la première ligne d'un produit. |
| `slug` | produit | Segment d'URL. Vide : dérivé du nom. |
| `description` | produit | Texte de la fiche, en Markdown. |
| `variant_group` | produit | Nom du groupe de variantes affiché à l'acheteur (« Taille »). Obligatoire dès qu'une ligne porte une variante. |
| `variant` | unité | Libellé de la variante (« M »). Vide : produit simple. |
| `price` | unité | Prix TTC en unités majeures. « 19,90 » ou « 19.90 ». |
| `stock` | unité | Quantité disponible, entier positif ou nul. |
| `weight_grams` | unité | Poids emballé en grammes. Vide = inconnu, ce qui n'est pas zéro. |
| `requires_shipping` | produit | oui/non. Défaut oui. |
| `active` | produit | oui/non. Défaut oui. |
| `categories` | produit | Slugs de catégories séparés par « \| ». |
| `images` | produit | Chemins d'images relatifs au CSV, séparés par « \| ». La première est la principale. |

Le séparateur est déduit de la ligne d'en-tête : un tableur français exporte en
`;`, ce qui évite d'avoir à guillemeter chaque prix.

## Ce que l'import garantit

- **rien n'est écrit tant que tout n'est pas jugé.** Une image illisible ou une
  catégorie inconnue arrête la totalité de l'import ;
- **idempotent par référence.** Relancer le même fichier ne produit aucune
  écriture, et une exécution interrompue reprend là où elle en était : l'import
  recalcule ce qui reste depuis l'état de la boutique ;
- **rien n'est supprimé.** Une variante qui quitte le fichier est désactivée, pas
  effacée — une commande passée la référence. Les produits absents du fichier ne
  sont pas touchés ;
- **les pertes se demandent.** Déplacer une URL (`--allow-slug-change`), retirer
  une unité vendue (`--allow-remove-variants`) et créer une catégorie
  (`--create-categories`) ont chacune leur option.

## Les images

Les chemins sont relatifs à ce dossier et ne peuvent pas en sortir. Le type est
lu dans les octets, pas dans l'extension : un fichier dont le nom ment sur son
contenu est refusé, et le SVG n'est jamais accepté. La clé de stockage est
dérivée du contenu, donc deux produits qui partagent une photo partagent un seul
objet, et un réimport n'en renvoie aucun.

La boutique sert ses images redimensionnées à la demande, en quatre largeurs :
une source plus grande que 2048 px est signalée mais acceptée telle quelle.
