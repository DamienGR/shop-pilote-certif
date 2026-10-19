import type { Catalog } from '../catalog.ts';

export const shipping = {
  // ─── Éditeur de livraison (/admin/shipping) ────────────────────────────────────
  'admin.shipping.title': 'Livraison',
  'admin.shipping.intro.before':
    'Zones, tarifs et seuils de livraison offerte. Les montants sont en {devise}, les poids se saisissent en',
  'admin.shipping.intro.middle': 'et sont stockés en grammes — l’unité se change dans les',
  'admin.shipping.intro.link': 'Réglages',
  'admin.shipping.viewCart': 'Voir le panier',
  'admin.shipping.saved': 'Configuration de livraison enregistrée.',
  'admin.shipping.conflict':
    'La livraison a été modifiée dans un autre onglet. Rechargez la page et vérifiez ces changements avant d’enregistrer les vôtres.',
  'admin.shipping.tooLarge':
    'Cette configuration est trop volumineuse pour être enregistrée. Retirez des zones ou des pays.',
  'admin.shipping.missingWeight.one':
    '{count} produit ({produits}) n’a pas de poids d’expédition et ne pourrait plus être acheté. Renseignez les poids ou gardez un prix forfaitaire dans chaque zone.',
  'admin.shipping.missingWeight.other':
    '{count} produits ({produits}) n’ont pas de poids d’expédition et ne pourraient plus être achetés. Renseignez les poids ou gardez un prix forfaitaire dans chaque zone.',
  'admin.shipping.invalid.heading': 'La configuration de livraison enregistrée est illisible :',
  'admin.shipping.invalid.before':
    'Les commandes de produits physiques sont bloquées tant qu’elle n’est pas remplacée. Vérifiez les valeurs ci-dessous, puis utilisez',
  'admin.shipping.invalid.after': 'pour l’écraser.',
  'admin.shipping.inherited.problems.before': 'Cette boutique utilise encore la configuration de livraison de',
  'admin.shipping.inherited.problems.after':
    ', qui autorise des valeurs que l’éditeur refuse. Les problèmes sont signalés ci-dessous — corrigez-les, puis enregistrez pour gérer la livraison depuis l’administration.',
  'admin.shipping.inherited.before': 'La livraison est actuellement définie dans',
  'admin.shipping.inherited.after':
    '. En enregistrant ici, vous la confiez à l’administration — cette page devient alors la seule référence.',
  'admin.shipping.offer.label': 'Proposer la livraison',
  'admin.shipping.offer.hint': '— demander une adresse et facturer des frais de livraison.',
  'admin.shipping.packageWeight.label': 'Poids de l’emballage ({unite})',
  'admin.shipping.packageWeight.hint':
    'Carton, enveloppe, calage et étiquette. Ajouté une fois par commande, en plus du poids des articles.',
  'admin.shipping.save': 'Enregistrer la livraison',
  'admin.shipping.replaceInvalid': 'Remplacer la configuration invalide',
  'admin.shipping.stripeNote':
    'Stripe affiche les tarifs du pays choisi dans le panier, puis confirme l’adresse définitive sur sa page de paiement. Les autres moyens de paiement demandent l’adresse avant le paiement.',

  // ─── Zones ─────────────────────────────────────────────────────────────────────
  'admin.shipping.zone.name': 'Nom de la zone',
  'admin.shipping.zone.moveUp': 'Monter',
  'admin.shipping.zone.moveDown': 'Descendre',
  'admin.shipping.zone.remove': 'Retirer la zone',
  'admin.shipping.zone.add': 'Ajouter une zone',
  'admin.shipping.zone.destinations': 'Destinations',
  'admin.shipping.zone.restOfWorld': 'Reste du monde',
  'admin.shipping.zone.unknownCode': 'Code inconnu : {code}',
  'admin.shipping.zone.freeOver': 'Livraison offerte dès ({devise})',
  'admin.shipping.zone.freeOverHint': 'Laisser vide pour désactiver.',

  // ─── Tarifs et tranches de poids ───────────────────────────────────────────────
  'admin.shipping.rate.label': 'Libellé du tarif',
  'admin.shipping.rate.pricing': 'Tarification',
  'admin.shipping.rate.mode.flat': 'Prix forfaitaire',
  'admin.shipping.rate.mode.weight': 'Selon le poids de la commande',
  'admin.shipping.rate.mode.pickup': 'Retrait sur place',
  'admin.shipping.rate.pickupFee': 'Frais (0 = gratuit)',
  'admin.shipping.rate.price': 'Prix',
  'admin.shipping.rate.remove': 'Retirer le tarif',
  'admin.shipping.rate.add': 'Ajouter un tarif',
  'admin.shipping.band.heading': 'Tranches de poids',
  'admin.shipping.band.upTo': 'Jusqu’à ({unite})',
  'admin.shipping.band.noMax': 'Sans maximum',
  'admin.shipping.band.add': 'Ajouter une tranche',

  // ─── Validation du document de livraison (features/shipping/settings.ts) ───────
  'admin.shipping.error.enabledType': 'L’activation doit valoir true ou false.',
  'admin.shipping.error.packageWeight': 'Indiquez un poids d’emballage égal ou supérieur à zéro.',
  'admin.shipping.error.zonesType': 'Les zones doivent former une liste.',
  'admin.shipping.error.zonesMax': 'Au maximum {max} zones.',
  'admin.shipping.error.zoneRequired':
    'Ajoutez au moins une zone avec un tarif avant d’activer la livraison.',
  'admin.shipping.error.zoneNameRequired': 'Donnez un nom à cette zone.',
  'admin.shipping.error.zoneNameLength': 'Le nom ne doit pas dépasser {max} caractères.',
  'admin.shipping.error.zoneNameTaken': 'Une autre zone porte déjà ce nom.',
  'admin.shipping.error.destinationRequired': 'Choisissez au moins une destination.',
  'admin.shipping.error.countriesMax': 'Au maximum {max} pays par zone.',
  'admin.shipping.error.restOfWorldAlone':
    '« Reste du monde » ne peut pas être combiné avec des pays précis.',
  'admin.shipping.error.restOfWorldOnce': 'Une seule zone peut être « Reste du monde ».',
  'admin.shipping.error.restOfWorldLast': '« Reste du monde » doit être la dernière zone.',
  'admin.shipping.error.unknownCountry': '{code} n’est pas un code pays.',
  'admin.shipping.error.countryTaken': '{pays} figure déjà dans une autre zone.',
  'admin.shipping.error.rateRequired': 'Ajoutez au moins un tarif de livraison.',
  'admin.shipping.error.amountAboveZero': 'Indiquez un montant supérieur à zéro.',
  'admin.shipping.error.optionsMax': 'Une zone peut proposer au maximum {max} options.',
  'admin.shipping.error.optionsMaxWithFree':
    'Une zone peut proposer au maximum {max} options (la livraison offerte en compte une).',
  'admin.shipping.error.rateNameRequired': 'Donnez un nom à ce tarif.',
  'admin.shipping.error.rateLabelLength': 'Le libellé ne doit pas dépasser {max} caractères.',
  'admin.shipping.error.rateLabelTaken': 'Un autre tarif de cette zone porte déjà ce libellé.',
  'admin.shipping.error.freeLabelReserved':
    '« {libelle} » est réservé tant qu’un seuil de livraison offerte est défini.',
  'admin.shipping.error.pricingMode': 'Choisissez un mode de tarification.',
  'admin.shipping.error.priceRequired': 'Indiquez un prix.',
  'admin.shipping.error.bandRequired': 'Ajoutez au moins une tranche de poids.',
  'admin.shipping.error.bandsMax': 'Au maximum {max} tranches par tarif.',
  'admin.shipping.error.noMaxNotLast': 'Seule la dernière tranche peut être sans maximum.',
  'admin.shipping.error.weightAboveZero': 'Indiquez un poids supérieur à zéro.',
  'admin.shipping.error.bandOrder':
    'Le maximum de chaque tranche doit dépasser celui de la tranche précédente.',
  'admin.shipping.error.maxWeightRequired': 'Indiquez un poids maximum.',
  'admin.shipping.error.weightNegative': 'Le poids ne peut pas être négatif.',
  'admin.shipping.error.weightPrecision': 'Trop de décimales pour une saisie en {unite}.',
  'admin.shipping.error.weightOverLimit': 'Ce poids est trop élevé pour un envoi en colis.',
  'admin.shipping.error.weightNotNumber': 'Indiquez le poids sous forme de nombre.',

  // ─── Document enregistré invalide (bandeau sur chaque page de l’admin) ─────────
  'admin.shipping.stored.notJson': 'La configuration de livraison enregistrée n’est pas du JSON valide.',
  'admin.shipping.stored.notObject': 'La configuration de livraison enregistrée n’est pas un objet.',
  'admin.shipping.stored.schema': 'Version de schéma de livraison non prise en charge : {version}.',
  'admin.shipping.stored.revision': 'La configuration de livraison n’a pas de révision valide.',
  'admin.shipping.stored.enabled': 'La configuration de livraison n’a pas de valeur d’activation valide.',
  'admin.shipping.stored.packageWeight': 'La configuration de livraison a un poids d’emballage invalide.',
  'admin.shipping.stored.zones': 'La configuration de livraison n’a pas de liste de zones.',
  'admin.shipping.stored.zone': 'La configuration de livraison contient une zone mal formée.',
  'admin.shipping.stored.rate': 'La configuration de livraison contient un tarif mal formé.',

  // ─── Achat d’étiquette de transport (features/shipping/labels.ts) ──────────────
  'admin.shipping.labelPurchase.parcelDimensions':
    'Indiquez la longueur, la largeur et la hauteur du colis en nombres positifs.',
  'admin.shipping.labelPurchase.parcelWeight': 'Indiquez le poids du colis emballé en nombre positif.',
  'admin.shipping.labelPurchase.noRate':
    'Aucun transporteur ne propose de tarif pour ce colis et cette adresse.',
  'admin.shipping.labelPurchase.reconcileShape':
    'Shippo a répondu dans un format inattendu — le rapprochement n’a pas abouti.',
  'admin.shipping.labelPurchase.reconcileConflicting':
    'Shippo renvoie des états de transaction contradictoires — le rapprochement n’a pas abouti.',
  'admin.shipping.labelPurchase.reconcilePurchasedIncomplete':
    'Shippo signale une étiquette achetée, mais son enregistrement est incomplet — faites le rapprochement dans le tableau de bord Shippo.',
  'admin.shipping.labelPurchase.reconcileRefundedIncomplete':
    'Shippo signale une étiquette remboursée, mais son enregistrement est incomplet — faites le rapprochement dans le tableau de bord Shippo.',
  'admin.shipping.labelPurchase.reconcileUnknownStatus':
    'Shippo signale un statut de transaction que cette version ne reconnaît pas — faites le rapprochement dans le tableau de bord Shippo.',
  'admin.shipping.labelPurchase.unreachable': 'Shippo est injoignable pour le moment.',
  'admin.shipping.labelPurchase.tokenRejected': 'Shippo a refusé le jeton d’API.',
  'admin.shipping.labelPurchase.unreadable': 'Shippo a répondu {statut} avec un contenu illisible.',
  'admin.shipping.labelPurchase.answered': 'Shippo a répondu {statut}.',
  'admin.shipping.labelPurchase.ratesExpired': 'Cette liste de tarifs a expiré. Redemandez les tarifs.',
  'admin.shipping.labelPurchase.notPurchased': 'Shippo n’a pas pu acheter cette étiquette.',
} satisfies Catalog;
