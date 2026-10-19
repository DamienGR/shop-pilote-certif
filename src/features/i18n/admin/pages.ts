import type { Catalog } from '../catalog.ts';

/** Content pages: the list, the new-page form, the Markdown editor and its presets. */
export const pages = {
  // ─── Commun ────────────────────────────────────────────────────────────────────
  'admin.pages.title': 'Pages',
  'admin.pages.backToList': 'Retour aux pages',
  'admin.pages.notFound': 'Page introuvable.',
  'admin.pages.status.published': 'Publiée',
  'admin.pages.status.draft': 'Brouillon',
  'admin.pages.field.title': 'Titre',
  'admin.pages.field.slug': 'Slug',
  'admin.pages.field.urlSlug': 'Slug de l’URL',
  'admin.pages.field.layout': 'Mise en page',

  // ─── Liste (/admin/pages) ──────────────────────────────────────────────────────
  'admin.pages.list.newPage': 'Nouvelle page',
  'admin.pages.list.empty.before':
    'Aucune page pour le moment. Créez-en une (à propos, livraison, retours, confidentialité…), puis ajoutez-la à la',
  'admin.pages.list.empty.link': 'navigation',
  'admin.pages.list.empty.after': 'pour que vos clients la trouvent.',
  'admin.pages.list.col.url': 'URL',
  'admin.pages.list.col.updated': 'Mise à jour',
  'admin.pages.list.confirmDelete': 'Supprimer cette page ?',
  'admin.pages.list.confirmDeleteLinked':
    'Cette page figure dans votre navigation. La supprimer masquera ce lien sur la vitrine. Continuer ?',

  // ─── Nouvelle page ─────────────────────────────────────────────────────────────
  'admin.pages.new.title': 'Nouvelle page',
  'admin.pages.new.slugPlaceholder': 'a-propos',
  'admin.pages.new.slugHint':
    'Laissez vide pour le générer à partir du titre. La page sera accessible à l’adresse /pages/<slug>.',
  'admin.pages.new.submit': 'Créer le brouillon',

  // ─── Éditeur ───────────────────────────────────────────────────────────────────
  'admin.pages.edit.documentTitle': 'Modifier « {titre} »',
  'admin.pages.edit.heading': 'Modifier la page',
  'admin.pages.edit.viewOnStore': 'Voir sur la boutique',
  'admin.pages.edit.publishHint':
    'Une page publiée figure dans le plan du site ; ajoutez-la à un menu depuis Navigation. Avec le cache de la vitrine, une modification peut mettre jusqu’à une minute à s’afficher.',
  'admin.pages.editor.viewLabel': 'Affichage de l’éditeur',
  'admin.pages.editor.mode.split': 'Côte à côte',
  'admin.pages.editor.previewHint': 'cliquez pour retrouver la source',
  'admin.pages.editor.rendering': 'Rendu en cours…',
  'admin.pages.editor.previewFailed': 'L’aperçu a échoué.',
  'admin.pages.editor.previewFailedStatus': 'L’aperçu a échoué ({statut}).',
  'admin.pages.editor.linkText': 'texte du lien',
  'admin.pages.editor.altPrompt': 'Décrivez cette image pour les lecteurs d’écran :',
  'admin.pages.editor.tool.heading': 'Intertitre',
  'admin.pages.editor.tool.bold': 'Gras',
  'admin.pages.editor.tool.boldShort': 'G',
  'admin.pages.editor.tool.italic': 'Italique',
  'admin.pages.editor.tool.link': 'Lien',
  'admin.pages.editor.tool.list': 'Liste à puces',
  'admin.pages.editor.tool.listShort': 'Liste',
  'admin.pages.editor.tool.numberedList': 'Liste numérotée',
  'admin.pages.editor.tool.quote': 'Citation',
  'admin.pages.editor.tool.code': 'Code en ligne',
  'admin.pages.editor.tool.codeShort': 'Code',
  // The empty editor's placeholder, one key per line of Markdown: the syntax
  // around these words is built in the template, so a translation cannot break it.
  'admin.pages.editor.placeholder.heading': 'Un intertitre',
  'admin.pages.editor.placeholder.intro':
    'Rédigez votre page en Markdown. Une ligne vide sépare deux paragraphes.',
  'admin.pages.editor.placeholder.bold': 'gras',
  'admin.pages.editor.placeholder.italic': 'italique',
  'admin.pages.editor.placeholder.bulletList': 'une liste à puces',
  'admin.pages.editor.placeholder.numberedList': 'une liste numérotée',
  'admin.pages.editor.placeholder.anotherItem': 'un autre élément',
  'admin.pages.editor.placeholder.quote': 'une citation',
  'admin.pages.editor.placeholder.link': 'un lien',
  'admin.pages.editor.placeholder.imageAlt': 'décrivez l’image',

  // ─── Mises en page (features/pages/layouts.ts) ─────────────────────────────────
  'admin.pages.layout.standard.label': 'Standard',
  'admin.pages.layout.standard.hint':
    'Colonne étroite, titre aligné à gauche. Idéal pour les conditions générales, la livraison et les retours.',
  'admin.pages.layout.editorial.label': 'Éditorial',
  'admin.pages.layout.editorial.hint':
    'Colonne étroite, titre centré. Idéal pour la présentation de la boutique et l’histoire de la marque.',
  'admin.pages.layout.wide.label': 'Large',
  'admin.pages.layout.wide.hint':
    'Pleine largeur, titre aligné à gauche. Idéal pour les guides des tailles, les tableaux et les grilles d’images.',

  // ─── Validation et messages d’enregistrement ───────────────────────────────────
  'admin.pages.form.titleRequired': 'Le titre est obligatoire.',
  'admin.pages.form.titleTooLong': 'Le titre ne doit pas dépasser {max} caractères.',
  'admin.pages.form.bodyTooLong': 'Le contenu de la page ne doit pas dépasser {max} caractères.',
  'admin.pages.save.publishRefused.one':
    'Modifications enregistrées, mais la page n’a pas été publiée : {count} image est introuvable dans la médiathèque.',
  'admin.pages.save.publishRefused.other':
    'Modifications enregistrées, mais la page n’a pas été publiée : {count} images sont introuvables dans la médiathèque.',
  'admin.pages.save.liveBroken.one':
    'Modifications enregistrées et en ligne, mais {count} image est introuvable dans la médiathèque et ne s’affichera pas.',
  'admin.pages.save.liveBroken.other':
    'Modifications enregistrées et en ligne, mais {count} images sont introuvables dans la médiathèque et ne s’afficheront pas.',
  'admin.pages.save.draftMissing.one':
    'Brouillon enregistré, mais {count} image est introuvable dans la médiathèque.',
  'admin.pages.save.draftMissing.other':
    'Brouillon enregistré, mais {count} images sont introuvables dans la médiathèque.',
} satisfies Catalog;
