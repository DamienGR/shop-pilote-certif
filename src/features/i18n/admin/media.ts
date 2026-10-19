import type { Catalog } from '../catalog.ts';

export const media = {
  // ─── Médiathèque ───────────────────────────────────────────────────────────────
  'admin.media.title': 'Médias',
  'admin.media.count.one': '{count} fichier.',
  'admin.media.count.other': '{count} fichiers.',
  'admin.media.intro': 'Une suppression ici retire le fichier partout — elle est refusée tant qu’il est encore utilisé.',
  'admin.media.upload': 'Importer',
  'admin.media.uploadHint': 'JPEG, PNG, WebP ou GIF. 5 Mo maximum par fichier.',
  'admin.media.empty': 'Aucun fichier pour l’instant. Importez-en un ci-dessus ou ajoutez une image à un produit — chaque import arrive ici.',
  'admin.media.size.bytes': '{taille} o',
  'admin.media.size.kilobytes': '{taille} Ko',
  'admin.media.size.megabytes': '{taille} Mo',
  'admin.media.legacy': 'Ancienne image',
  'admin.media.unused': 'Inutilisé',
  'admin.media.usedBy': 'Utilisé par',
  'admin.media.copyUrl': 'Copier l’URL',
  'admin.media.copied': 'Copiée',

  // ─── Utilisations d’un fichier (usage.ts) ──────────────────────────────────────
  'admin.media.usage.editProduct': 'Modifier « {nom} »',
  'admin.media.usage.editPage': 'Modifier la page « {titre} »',
  'admin.media.usage.logo': 'Logo de la boutique',
  'admin.media.usage.logoTitle': 'Changer le logo dans Réglages',
  'admin.media.usage.products.one': '{count} produit ({noms})',
  'admin.media.usage.products.other': '{count} produits ({noms})',
  'admin.media.usage.pages.one': '{count} page ({titres})',
  'admin.media.usage.pages.other': '{count} pages ({titres})',
  'admin.media.usage.theLogo': 'le logo de la boutique',
  'admin.media.usage.and': 'et',

  // ─── Erreurs d’import et de suppression ────────────────────────────────────────
  'admin.media.error.type': 'L’image doit être au format JPEG, PNG, WebP ou GIF.',
  'admin.media.error.size': 'L’image ne doit pas dépasser 5 Mo.',
  'admin.media.error.alreadyAttached': 'Cette image est déjà dans la galerie de ce produit.',
  'admin.media.error.gone': 'Cette image n’est plus dans la médiathèque.',
  'admin.media.error.noFiles': 'Choisissez au moins une image.',
  'admin.media.error.inUse': 'Impossible de supprimer ce fichier : il est encore utilisé par {usages}. Retirez-le d’abord de ces emplacements.',
  'admin.media.error.invalidId': 'Identifiant invalide.',
  'admin.media.error.unknownAction': 'Action inconnue.',
  'admin.media.error.notFound': 'Fichier introuvable.',

  // ─── Sélecteur de médias (MediaPicker) ─────────────────────────────────────────
  'admin.media.picker.label': 'Choisir dans la médiathèque',
  'admin.media.picker.title': 'Choisir une image',
  'admin.media.picker.close': 'Fermer',
  'admin.media.picker.prev': 'Précédent',
  'admin.media.picker.next': 'Suivant',
  'admin.media.picker.empty': 'Aucune image pour l’instant.',
  // Rendered unsubstituted into a data attribute: the picker pages on the
  // client, so its script fills {debut}, {fin} and {total} itself.
  'admin.media.picker.range': '{debut}–{fin} sur {total}',
  'admin.media.picker.loadFailed': 'Impossible de charger la médiathèque.',
  'admin.media.picker.chooseFile': 'Choisissez d’abord un fichier.',
  'admin.media.picker.uploadFailed': 'Échec de l’import.',
} satisfies Catalog;
