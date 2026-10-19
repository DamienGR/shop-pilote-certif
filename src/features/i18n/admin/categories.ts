import type { Catalog } from '../catalog.ts';

export const categories = {
  // ─── Liste des catégories ──────────────────────────────────────────────────────
  'admin.categories.title': 'Catégories',
  'admin.categories.new': 'Nouvelle catégorie',
  'admin.categories.column.slug': 'Slug',
  'admin.categories.column.products': 'Produits',
  'admin.categories.empty': 'Aucune catégorie pour l’instant.',
  'admin.categories.confirmDelete': 'Supprimer cette catégorie ? Ses sous-catégories remonteront sous sa catégorie parente.',
  'admin.categories.confirmDeleteLinked': 'Cette catégorie figure dans votre navigation : la supprimer masquera ce lien sur la vitrine. Ses sous-catégories remonteront sous sa catégorie parente. Continuer ?',

  // ─── Création et modification ──────────────────────────────────────────────────
  'admin.categories.back': 'Retour aux catégories',
  'admin.categories.create': 'Créer la catégorie',
  'admin.categories.edit.title': 'Modifier « {nom} »',
  'admin.categories.edit.heading': 'Modifier la catégorie',
  'admin.categories.edit.submit': 'Enregistrer les modifications',
  'admin.categories.notFound': 'Catégorie introuvable.',

  // ─── Formulaire ────────────────────────────────────────────────────────────────
  'admin.categories.form.slugHint': '(URL — laissez vide pour le générer à partir du nom)',
  'admin.categories.form.slugPlaceholder': 'automatique',
  'admin.categories.form.parent': 'Catégorie parente',
  'admin.categories.form.noParent': '— aucune (premier niveau) —',
  'admin.categories.error.nameRequired': 'Le nom est obligatoire.',
  'admin.categories.error.invalidParent': 'Catégorie parente invalide.',
  'admin.categories.error.parentGone': 'Cette catégorie parente n’existe plus.',
  'admin.categories.error.cycle': 'Une catégorie ne peut pas être placée sous elle-même ni sous l’une de ses sous-catégories.',
} satisfies Catalog;
