import type { Catalog } from '../catalog.ts';

/**
 * Words every Admin screen uses the same way. A screen-specific sentence gets
 * its own key in that screen's fragment, even when it starts with one of these:
 * "Enregistrer" on a button and "Enregistrer le produit" are two strings.
 */
export const common = {
  'admin.common.save': 'Enregistrer',
  'admin.common.saved': 'Modifications enregistrées.',
  'admin.common.cancel': 'Annuler',
  'admin.common.delete': 'Supprimer',
  'admin.common.edit': 'Modifier',
  'admin.common.remove': 'Retirer',
  'admin.common.add': 'Ajouter',
  'admin.common.search': 'Rechercher',
  'admin.common.clear': 'Effacer',
  'admin.common.view': 'Voir',
  'admin.common.preview': 'Aperçu',
  'admin.common.yes': 'Oui',
  'admin.common.no': 'Non',
  'admin.common.actions': 'Actions',
  'admin.common.status': 'Statut',
  'admin.common.name': 'Nom',
  'admin.common.email': 'E-mail',
  'admin.common.date': 'Date',
  'admin.common.total': 'Total',
  'admin.common.optional': 'facultatif',
  'admin.common.loading': 'Chargement…',
} satisfies Catalog;
