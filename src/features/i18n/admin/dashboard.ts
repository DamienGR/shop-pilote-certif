import type { Catalog } from '../catalog.ts';

export const dashboard = {
  // ─── Tableau de bord ───────────────────────────────────────────────────────────
  'admin.dashboard.title': 'Tableau de bord',
  'admin.dashboard.card.netRevenue': 'Chiffre d’affaires net',
  'admin.dashboard.card.refunded': 'Remboursements : {montant}',
  'admin.dashboard.card.orders': 'Commandes',
  'admin.dashboard.card.products': 'Produits',
  'admin.dashboard.card.customers': 'Clients',
  'admin.dashboard.viewAll': 'Tout voir',
  'admin.dashboard.recentOrders': 'Commandes récentes',
  'admin.dashboard.noOrders': 'Aucune commande pour l’instant.',
  'admin.dashboard.lowStock': 'Stock faible',
  'admin.dashboard.stockLeft': '{nombre} en stock',
  'admin.dashboard.wellStocked': 'Tout est bien approvisionné.',

  // ─── Graphique du chiffre d’affaires (RevenueChart) ────────────────────────────
  'admin.dashboard.chart.heading': 'Chiffre d’affaires · {nombre} derniers jours',
  'admin.dashboard.chart.label': 'Chiffre d’affaires quotidien des {nombre} derniers jours',
  'admin.dashboard.chart.bar': '{jour} : {montant} · {commandes}',
  'admin.dashboard.chart.orders.one': '{count} commande',
  'admin.dashboard.chart.orders.other': '{count} commandes',
} satisfies Catalog;
