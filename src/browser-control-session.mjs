const COMMANDS = new Set(['open-tab', 'close-tab', 'activate-tab', 'navigate'])

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

export class BrowserControlSession {
  #tabs = new Map()
  #events = []
  #sequence = 0

  constructor({ sessionId, agentId, now = () => Date.now() }) {
    if (!boundedString(sessionId, 256) || !boundedString(agentId, 256)) {
      throw new TypeError('browser session requires bounded session and agent ids')
    }
    this.sessionId = sessionId
    this.agentId = agentId
    this.now = now
    this.controller = Object.freeze({ type: 'agent', id: agentId })
    this.activeTabId = this.#createTab('about:blank')
    this.#append('browser.session.created', { agentId })
  }

  takeHumanControl(humanId) {
    if (!boundedString(humanId, 256)) return this.#deny('INVALID_HUMAN_ID')
    if (this.controller.type === 'human') {
      if (this.controller.id === humanId) return this.#allow('CONTROL_ALREADY_HELD')
      return this.#deny('CONTROL_HELD_BY_ANOTHER_HUMAN')
    }

    this.controller = Object.freeze({ type: 'human', id: humanId })
    this.#append('browser.control.taken', { humanId })
    return this.#allow('HUMAN_CONTROL_ACTIVE')
  }

  returnControlToAgent(humanId) {
    if (this.controller.type !== 'human') return this.#deny('HUMAN_CONTROL_NOT_ACTIVE')
    if (this.controller.id !== humanId) return this.#deny('CONTROL_OWNER_MISMATCH')

    this.controller = Object.freeze({ type: 'agent', id: this.agentId })
    this.#append('browser.control.returned', { humanId, agentId: this.agentId })
    return this.#allow('AGENT_CONTROL_ACTIVE')
  }

  authorize({ actorType, actorId, command = 'input' }) {
    if (!['agent', 'human'].includes(actorType) || !boundedString(actorId, 256)) {
      return this.#deny('INVALID_ACTOR')
    }
    if (this.controller.type === actorType && this.controller.id === actorId) {
      return this.#allow('CONTROL_OWNER')
    }
    const reason = this.controller.type === 'human'
      ? 'HUMAN_CONTROL_ACTIVE'
      : 'AGENT_CONTROL_ACTIVE'
    this.#append('browser.command.rejected', { actorType, actorId, command, reason })
    return this.#deny(reason)
  }

  record(kind, fact = {}) {
    if (!boundedString(kind, 128) || !fact || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new TypeError('browser activity event is invalid')
    }
    this.#append(kind, fact)
  }

  dispatch({ actorType, actorId, command, tabId, url }) {
    const authorization = this.authorize({ actorType, actorId, command })
    if (authorization.status === 'denied') return authorization
    if (!COMMANDS.has(command)) return this.#deny('UNKNOWN_BROWSER_COMMAND')

    if (command === 'open-tab') {
      const destination = url ?? 'about:blank'
      if (!boundedString(destination)) return this.#deny('INVALID_URL')
      const createdTabId = this.#createTab(destination)
      this.activeTabId = createdTabId
      this.#append('browser.tab.opened', { actorType, actorId, tabId: createdTabId, url: this.#tabs.get(createdTabId).url })
      return this.#allow('TAB_OPENED', { tabId: createdTabId })
    }

    if (!boundedString(tabId, 256) || !this.#tabs.has(tabId)) return this.#deny('TAB_NOT_FOUND')

    if (command === 'activate-tab') {
      this.activeTabId = tabId
      this.#append('browser.tab.activated', { actorType, actorId, tabId })
      return this.#allow('TAB_ACTIVATED', { tabId })
    }

    if (command === 'navigate') {
      if (!boundedString(url)) return this.#deny('INVALID_URL')
      const tab = this.#tabs.get(tabId)
      this.#tabs.set(tabId, Object.freeze({ ...tab, url }))
      this.#append('browser.tab.navigated', { actorType, actorId, tabId, url })
      return this.#allow('TAB_NAVIGATED', { tabId })
    }

    this.#tabs.delete(tabId)
    if (this.#tabs.size === 0) this.activeTabId = this.#createTab('about:blank')
    else if (this.activeTabId === tabId) this.activeTabId = this.#tabs.keys().next().value
    this.#append('browser.tab.closed', { actorType, actorId, tabId })
    return this.#allow('TAB_CLOSED', { tabId })
  }

  snapshot() {
    return Object.freeze({
      sessionId: this.sessionId,
      agentId: this.agentId,
      controller: this.controller,
      activeTabId: this.activeTabId,
      tabs: Object.freeze([...this.#tabs.values()]),
    })
  }

  events() {
    return structuredClone(this.#events)
  }

  #createTab(url) {
    if (!boundedString(url)) throw new TypeError('tab URL is invalid')
    const tabId = `tab-${++this.#sequence}`
    this.#tabs.set(tabId, Object.freeze({ tabId, url }))
    return tabId
  }

  #append(kind, fact) {
    this.#events.push(Object.freeze({
      sequence: this.#events.length + 1,
      at: new Date(this.now()).toISOString(),
      kind,
      sessionId: this.sessionId,
      ...fact,
    }))
  }

  #allow(reason, extra = {}) {
    return Object.freeze({ status: 'allowed', reason, ...extra })
  }

  #deny(reason) {
    return Object.freeze({ status: 'denied', reason })
  }
}
