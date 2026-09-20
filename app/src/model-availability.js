export function isSelectableConversationModel(provider, model, { allowCatalogOnly = false } = {}) {
  return provider.configured === true && model.capabilities?.includes('conversation') === true
    && (['authenticated', 'verified-route', 'verified-manual'].includes(model.availability)
      || (allowCatalogOnly && model.availability === 'catalog-only')
      || model.availability === 'available'
      || (provider.id === 'antigravity' && model.availability === 'local-ready'))
}
