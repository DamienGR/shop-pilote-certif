import type { Catalog } from '../catalog.ts';

/** Navigation: the header and footer menus, their item picker and its errors. */
export const navigation = {
  // ─── Écran ─────────────────────────────────────────────────────────────────────
  'admin.navigation.title': 'Navigation',
  'admin.navigation.intro':
    'Choisissez ce qui apparaît dans votre en-tête et votre pied de page. Les modifications sont visibles sur la vitrine en moins d’une minute.',
  'admin.navigation.saved': 'Navigation mise à jour.',

  // ─── Types de cible ────────────────────────────────────────────────────────────
  'admin.navigation.type.home': 'Accueil',
  'admin.navigation.type.catalog': 'Catalogue',
  'admin.navigation.type.page': 'Page',
  'admin.navigation.type.product': 'Produit',
  'admin.navigation.type.category': 'Catégorie',

  // ─── Menus ─────────────────────────────────────────────────────────────────────
  'admin.navigation.location.header': 'En-tête',
  'admin.navigation.location.footer': 'Pied de page',
  'admin.navigation.location.headerNote':
    'Jusqu’à {max} éléments — l’en-tête affiche aussi votre logo, la recherche et le panier.',
  'admin.navigation.location.footerNote': 'Jusqu’à {max} éléments.',

  // ─── Ajouter un élément ────────────────────────────────────────────────────────
  'admin.navigation.add.heading': 'Ajouter un élément',
  'admin.navigation.add.type': 'Type',
  'admin.navigation.add.searchPlaceholder': 'Filtrer par nom',
  'admin.navigation.add.searchAll': 'Tout rechercher',
  'admin.navigation.add.noMatches': 'Aucun résultat',
  'admin.navigation.add.noMatchesTruncated': 'Aucun résultat ici — essayez « Tout rechercher »',
  'admin.navigation.add.noneAvailable': 'Aucun élément disponible',
  'admin.navigation.add.label': 'Libellé',
  'admin.navigation.add.labelDefault': 'Par défaut : « {nom} »',
  'admin.navigation.add.labelDefaultGeneric': 'Par défaut : son nom',
  'admin.navigation.add.location': 'Ajouter à',
  'admin.navigation.add.nothingMatches': 'Aucun résultat — effacez ou élargissez votre recherche',
  'admin.navigation.truncated.page': 'Pages : {limite} affichées sur {total}',
  'admin.navigation.truncated.product': 'Produits : {limite} affichés sur {total}',
  'admin.navigation.truncated.category': 'Catégories : {limite} affichées sur {total}',
  'admin.navigation.truncated.hint':
    'Tapez pour filtrer ; cliquez sur « Tout rechercher » pour aller au-delà.',

  // ─── Listes des menus ──────────────────────────────────────────────────────────
  'admin.navigation.rootLinks.before': 'Les liens Accueil et Catalogue mènent tous deux à',
  'admin.navigation.rootLinks.after':
    'pour l’instant. Ils seront distincts dès que vous aurez choisi une page d’accueil personnalisée dans Réglages.',
  'admin.navigation.empty': 'Aucun élément pour le moment.',
  'admin.navigation.item.untitled': 'Sans titre',
  'admin.navigation.item.rename': 'Modifier le texte du lien',
  'admin.navigation.item.linkText': 'Texte du lien',
  'admin.navigation.item.renameHint': 'Ne change que le texte affiché dans ce menu.',
  'admin.navigation.item.renameHintNamed':
    'Ne change que le texte affiché dans ce menu — laissez vide pour utiliser « {nom} ».',
  'admin.navigation.item.moveUp': 'Monter',
  'admin.navigation.item.moveDown': 'Descendre',
  'admin.navigation.item.remove': 'Retirer {nom}',
  'admin.navigation.item.confirmRemove.header': 'Retirer « {nom} » du menu d’en-tête ?',
  'admin.navigation.item.confirmRemove.footer': 'Retirer « {nom} » du pied de page ?',

  // ─── Cibles indisponibles (features/navigation/admin.ts) ───────────────────────
  'admin.navigation.unavailable.missing': 'La cible n’existe plus',
  'admin.navigation.unavailable.draft': 'Brouillon — invisible sur la vitrine',
  'admin.navigation.unavailable.inactive': 'Inactif — invisible sur la vitrine',
  'admin.navigation.unavailable.other': 'Indisponible',

  // ─── Erreurs de /api/admin/navigation ──────────────────────────────────────────
  'admin.navigation.error.full.header':
    'Le menu d’en-tête est complet ({max} éléments). Retirez-en un d’abord.',
  'admin.navigation.error.full.footer':
    'Le pied de page est complet ({max} éléments). Retirez-en un d’abord.',
  'admin.navigation.error.duplicate.header': '{element} figure déjà dans le menu d’en-tête.',
  'admin.navigation.error.duplicate.footer': '{element} figure déjà dans le pied de page.',
  'admin.navigation.error.unavailable':
    'Cette page, ce produit ou cette catégorie n’est plus disponible.',
  'admin.navigation.error.noTarget': 'Choisissez d’abord une cible.',
  'admin.navigation.error.reorderMismatch':
    'Le nouvel ordre ne correspond pas au menu. Rechargement…',
  'admin.navigation.error.unknownAction': 'Action inconnue.',
  'admin.navigation.error.invalidLocation': 'Emplacement invalide.',
  'admin.navigation.error.invalidTargetType': 'Type de cible invalide.',
  'admin.navigation.error.invalidId': 'Élément introuvable.',
} satisfies Catalog;
