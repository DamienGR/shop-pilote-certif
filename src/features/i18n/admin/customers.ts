import type { Catalog } from '../catalog.ts';

export const customers = {
  // ─── Liste des clients ─────────────────────────────────────────────────────────
  'admin.customers.title': 'Clients',
  'admin.customers.column.orders': 'Commandes',
  'admin.customers.column.lifetime': 'Total des achats',
  'admin.customers.column.lastOrder': 'Dernière commande',
  'admin.customers.empty': 'Aucun client pour l’instant.',

  // ─── Fiche client ──────────────────────────────────────────────────────────────
  'admin.customers.detail.back': 'Retour aux clients',
  'admin.customers.detail.notFound': 'Client introuvable.',
  'admin.customers.detail.summary.one': '{count} commande · {montant} au total',
  'admin.customers.detail.summary.other': '{count} commandes · {montant} au total',
  'admin.customers.detail.column.order': 'Commande',
} satisfies Catalog;
