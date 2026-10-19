import type { Catalog } from '../catalog.ts';

export const shell = {
  // ─── Coquille de l’administration (AdminLayout) ────────────────────────────────
  'admin.shell.title': '{titre} — {boutique} · administration',
  'admin.shell.titleBare': '{boutique} · administration',
  'admin.shell.eyebrow': 'Administration',
  'admin.shell.nav.dashboard': 'Tableau de bord',
  'admin.shell.nav.products': 'Produits',
  'admin.shell.nav.orders': 'Commandes',
  'admin.shell.nav.customers': 'Clients',
  'admin.shell.nav.categories': 'Catégories',
  'admin.shell.nav.pages': 'Pages',
  'admin.shell.nav.navigation': 'Navigation',
  'admin.shell.nav.shipping': 'Livraison',
  'admin.shell.nav.media': 'Médias',
  'admin.shell.nav.settings': 'Réglages',
  'admin.shell.nav.menu': 'Menu',
  'admin.shell.nav.toggle': 'Afficher ou masquer les sections de l’administration',
  'admin.shell.viewStore': 'Voir la boutique',
  'admin.shell.logout': 'Se déconnecter',

  // ─── Bandeaux ──────────────────────────────────────────────────────────────────
  'admin.shell.setupNudge.title': 'Terminez la configuration de votre boutique',
  'admin.shell.setupNudge.detail': 'nom de la boutique, état des paiements, etc.',
  'admin.shell.demoBanner.title': 'Aucun moyen de paiement réel n’est configuré.',
  'admin.shell.demoBanner.before': 'Pour l’instant, seule l’option',
  'admin.shell.demoBanner.middle': 'permet de commander — ces commandes sont enregistrées avec l’étiquette',
  'admin.shell.demoBanner.after': '. Les clients voient des liens de configuration pour la carte et Lightning tant que vous n’avez pas ajouté de clé. L’option de démonstration disparaît dès qu’un vrai moyen de paiement est actif.',
  'admin.shell.shippingBlocked': 'Les commandes à livrer sont bloquées par une configuration invalide :',
  'admin.shell.inventory.title': 'Le stock demande votre attention.',
  'admin.shell.inventory.one': '{count} ligne de commande payée a été réglée après l’expiration de sa réservation de stock et n’a pas pu être entièrement déduite du stock.',
  'admin.shell.inventory.other': '{count} lignes de commande payées ont été réglées après l’expiration de leur réservation de stock et n’ont pas pu être entièrement déduites du stock.',
  'admin.shell.inventory.action': 'Ouvrez les commandes concernées et régularisez le stock.',

  // ─── Porte d’entrée (middleware) ───────────────────────────────────────────────
  'admin.shell.gate.authRequired': 'Authentification requise.',
  'admin.shell.gate.invalidAccessToken': 'Jeton Cloudflare Access invalide.',
  'admin.shell.gate.accessMisconfigured': 'Cloudflare Access est mal configuré : définissez à la fois CF_ACCESS_TEAM_DOMAIN et CF_ACCESS_AUD.',
  'admin.shell.gate.accessRequired': 'Authentification Cloudflare Access requise.',
  'admin.shell.gate.accessNotConfigured': 'Cloudflare Access n’est pas configuré : définissez CF_ACCESS_TEAM_DOMAIN et CF_ACCESS_AUD.',
  'admin.shell.gate.notSetUp': 'L’administration n’est pas encore configurée — passez d’abord par /admin/setup.',
} satisfies Catalog;
