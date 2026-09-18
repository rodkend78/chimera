export function isSelectableConversationModel(provider, model) {
  return provider.configured === true && model.capabilities?.includes('conversation') === true
    && (['authenticated', 'verified-route', 'verified-manual'].includes(model.availability)
      || (provider.id === 'antigravity' && model.availability === 'local-ready'))
}
