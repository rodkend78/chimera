import crypto from 'node:crypto'
import { BrowserControlSession } from '../browser-control-session.mjs'
import { sha256 } from '../canonical.mjs'
import { signAction, signHumanAction } from '../identity.mjs'
import { ChromiumBrowserExecutor, assertSafeBrowserUrl, validateHumanInput } from './executor.mjs'
import { redactSensitiveBrowserUrl } from './auth-navigation.mjs'

const COMMANDS = new Set([
  'open-tab',
  'activate-tab',
  'close-tab',
  'navigate',
  'back',
  'forward',
  'reload',
  'read',
  'snapshot',
  'click',
  'type',
  'key',
  'scroll',
  'browser-files',
  'upload-files',
  'download-file',
])

function isoWindow(now, lifetimeMs = 15 * 60_000) {
  return {
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + lifetimeMs).toISOString(),
  }
}

function capabilityFor(command) {
  if (['browser-files', 'upload-files', 'download-file'].includes(command)) return 'browser.input'
  if (['read', 'snapshot', 'activate-tab'].includes(command)) return 'browser.observe'
  if (['open-tab', 'close-tab', 'navigate', 'back', 'forward', 'reload'].includes(command)) return 'browser.navigate'
  if (command === 'type' || command === 'key') return 'browser.input'
  return 'browser.interact'
}

function operationFor(command) {
  return command.replaceAll('-', '_')
}

function boundedString(value, maximum = 2048) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function trustedScope(scope) {
  if (scope === undefined || scope === null) return { taskId: null, nodeId: null }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new TypeError('BROWSER_SCOPE_INVALID')
  const taskId = scope.taskId ?? null
  const nodeId = scope.nodeId ?? null
  if ((taskId !== null && !boundedString(taskId, 256))
    || (nodeId !== null && !boundedString(nodeId, 128))
    || (nodeId !== null && taskId === null)) throw new TypeError('BROWSER_SCOPE_INVALID')
  return { taskId, nodeId }
}

function sameAction(payload, expected) {
  return payload?.agentId === expected.actorId
    && payload?.sessionId === expected.sessionId
    && payload?.capability === expected.capability
    && payload?.resource === expected.resource
    && payload?.operation === expected.operation
    && payload?.commandHash === expected.commandHash
    && (payload?.taskId ?? null) === expected.taskId
    && (payload?.nodeId ?? null) === expected.nodeId
}

function sameHumanAction(payload, expected) {
  return payload?.humanId === expected.actorId
    && payload?.sessionId === expected.sessionId
    && payload?.capability === expected.capability
    && payload?.resource === expected.resource
    && payload?.operation === expected.operation
    && payload?.commandHash === expected.commandHash
}

export class OpenBotBrowserComputerAdapter {
  #executor
  #control
  #state
  #pending = new Map()
  #controlVersion = 0
  #started = false
  #inputQueue = Promise.resolve()
  #queuedInputs = 0
  #refreshingState

  constructor({
    sessionId,
    agentId,
    humanId,
    agentIdentity,
    humanIdentity,
    grant,
    gateway,
    audit,
    realtimeAudit = audit,
    profileDir,
    executor,
    now = () => Date.now(),
  }) {
    for (const value of [sessionId, agentId, humanId]) {
      if (!boundedString(value, 256)) throw new TypeError('browser adapter requires bounded actor and session ids')
    }
    if (!agentIdentity?.privateKey || !humanIdentity?.privateKey || !grant || !gateway || !audit) {
      throw new TypeError('browser adapter requires identities, grant, gateway, and audit')
    }
    this.sessionId = sessionId
    this.agentId = agentId
    this.humanId = humanId
    this.agentIdentity = agentIdentity
    this.humanIdentity = humanIdentity
    this.grant = grant
    this.gateway = gateway
    this.audit = audit
    this.realtimeAudit = realtimeAudit
    this.now = now
    this.#control = new BrowserControlSession({ sessionId, agentId, now })
    this.#executor = executor ?? new ChromiumBrowserExecutor({ profileDir })
  }

  async start() {
    if (this.#started) return this.state()
    this.#state = await this.#executor.start()
    this.#started = true
    this.audit.append({
      kind: 'browser.session.started',
      sessionId: this.sessionId,
      actorType: 'system',
      actorId: 'chimera-browser-adapter',
      at: new Date(this.now()).toISOString(),
    })
    return this.state()
  }

  state() {
    return structuredClone(this.#state ?? { running: false, tabs: [] })
  }

  async refreshState() {
    // Page links, redirects and popups do not pass through humanCommand.
    // Refresh metadata on the UI's state read, never on the realtime input path.
    if (!this.#state?.running) return this.state()
    if (!this.#refreshingState) {
      const version = this.#controlVersion
      this.#refreshingState = (async () => {
        const next = await this.#executor.state()
        if (version === this.#controlVersion && this.#state?.running) this.#state = next
        return this.state()
      })().finally(() => { this.#refreshingState = undefined })
    }
    return this.#refreshingState
  }

  controller() {
    return this.#control.snapshot().controller
  }

  events() {
    return this.#control.events()
  }

  pendingAction(actionId) {
    const pending = this.#pending.get(actionId)
    return pending ? structuredClone(pending) : null
  }

  async agentCommand(input, { grant = this.grant, action, scope } = {}) {
    const prepared = this.#prepareCommand(input, 'agent')
    if (prepared.status === 'denied') return prepared
    let trusted
    try { trusted = trustedScope(scope) } catch (error) {
      return this.#recordBrowserAction(undefined, input.command, 'agent', this.agentId, prepared.resource, 'denied', error.code)
    }

    const envelope = action ?? signAction({
      actionId: `browser-${crypto.randomUUID()}`,
      agentId: this.agentId,
      sessionId: this.sessionId,
      capability: prepared.capability,
      resource: prepared.resource,
      operation: prepared.operation,
      commandHash: sha256(input),
      ...(trusted.taskId ? { taskId: trusted.taskId } : {}),
      ...(trusted.nodeId ? { nodeId: trusted.nodeId } : {}),
      ...isoWindow(this.now()),
    }, this.agentIdentity)

    const expected = {
      actorId: this.agentId,
      sessionId: this.sessionId,
      capability: prepared.capability,
      resource: prepared.resource,
      operation: prepared.operation,
      commandHash: sha256(input),
      taskId: trusted.taskId,
      nodeId: trusted.nodeId,
    }
    if (!sameAction(envelope?.payload, expected)) {
      return this.#recordBrowserAction(envelope?.payload?.actionId, input.command, 'agent', this.agentId, prepared.resource, 'denied', 'ACTION_COMMAND_MISMATCH')
    }

    const decision = this.gateway.submit({ grant, action: envelope })
    if (decision.status === 'pending') {
      this.#pending.set(decision.actionId, {
        action: envelope,
        command: structuredClone(input),
        controlVersion: this.#controlVersion,
        resource: prepared.resource,
        scope: trusted,
      })
      this.#recordBrowserAction(decision.actionId, input.command, 'agent', this.agentId, prepared.resource, 'pending', decision.reason)
      return decision
    }
    if (decision.status !== 'allowed') {
      this.#recordBrowserAction(decision.actionId, input.command, 'agent', this.agentId, prepared.resource, 'denied', decision.reason)
      return decision
    }
    return this.#executeAuthorized({
      actionId: decision.actionId,
      actorType: 'agent',
      actorId: this.agentId,
      command: input,
      resource: prepared.resource,
      decision,
    })
  }

  async decide(decision) {
    const actionId = decision?.payload?.actionId
    const pending = this.#pending.get(actionId)
    const result = this.gateway.decide(decision)
    if (!pending) return result
    this.#pending.delete(actionId)

    if (result.status !== 'allowed') {
      this.#recordBrowserAction(actionId, pending.command.command, 'agent', this.agentId, pending.resource, 'denied', result.reason)
      return result
    }
    if (pending.controlVersion !== this.#controlVersion) {
      const denied = { status: 'denied', actionId, reason: 'ACTION_REVALIDATION_REQUIRED' }
      this.#recordBrowserAction(actionId, pending.command.command, 'agent', this.agentId, pending.resource, 'denied', denied.reason)
      return denied
    }
    return this.#executeAuthorized({
      actionId,
      actorType: 'agent',
      actorId: this.agentId,
      command: pending.command,
      resource: pending.resource,
      decision: result,
    })
  }

  cancelPending(actionId, reason = 'ACTION_CANCELLED') {
    const pending = this.#pending.get(actionId)
    const result = this.gateway.cancelPending(actionId, reason)
    if (!pending) return result
    this.#pending.delete(actionId)
    this.#recordBrowserAction(actionId, pending.command.command, 'agent', this.agentId, pending.resource, 'denied', result.reason)
    return result
  }

  async humanCommand(input, { action } = {}) {
    const prepared = this.#prepareCommand(input, 'human')
    if (prepared.status === 'denied') return prepared
    const envelope = action ?? this.#signHuman({
      capability: prepared.capability,
      resource: prepared.resource,
      operation: prepared.operation,
      commandHash: sha256(input),
    })
    const expected = {
      actorId: this.humanId,
      sessionId: this.sessionId,
      capability: prepared.capability,
      resource: prepared.resource,
      operation: prepared.operation,
      commandHash: sha256(input),
    }
    if (!sameHumanAction(envelope?.payload, expected)) {
      return this.#recordBrowserAction(envelope?.payload?.actionId, input.command, 'human', this.humanId, prepared.resource, 'denied', 'ACTION_COMMAND_MISMATCH')
    }

    const decision = this.gateway.submitHuman({ action: envelope })
    if (decision.status !== 'allowed') {
      this.#recordBrowserAction(decision.actionId, input.command, 'human', this.humanId, prepared.resource, 'denied', decision.reason)
      return decision
    }
    return this.#executeAuthorized({
      actionId: decision.actionId,
      actorType: 'human',
      actorId: this.humanId,
      command: input,
      resource: prepared.resource,
      decision,
    })
  }

  takeControl({ action } = {}) {
    return this.#changeControl('take_control', action)
  }

  returnControl({ action } = {}) {
    return this.#changeControl('return_control', action)
  }

  humanStreamInput(message, options = {}) {
    try { validateHumanInput(message) } catch {
      return Promise.resolve({ status: 'denied', reason: 'INVALID_BROWSER_INPUT' })
    }
    if (this.#queuedInputs >= 256) return Promise.resolve({ status: 'denied', reason: 'BROWSER_INPUT_BACKPRESSURE' })
    const controlVersion = this.#controlVersion
    const input = structuredClone(message)
    this.#queuedInputs += 1
    const result = this.#inputQueue.then(() => this.#humanStreamInput(input, { ...options, controlVersion }))
    this.#inputQueue = result.catch(() => undefined).finally(() => { this.#queuedInputs -= 1 })
    return result
  }

  async releaseHumanInput() {
    const result = this.#inputQueue.then(() => this.#executor.releaseHumanInput?.())
    this.#inputQueue = result.catch(() => undefined)
    return result
  }

  humanFileState() {
    const lease = this.#control.authorize({ actorType: 'human', actorId: this.humanId, command: 'browser-files' })
    if (lease.status !== 'allowed') return { status: 'denied', reason: lease.reason }
    if (!this.#state?.running) return { status: 'denied', reason: 'SESSION_SUSPENDED' }
    return { status: 'allowed', result: this.#executor.browserFiles() }
  }

  async #humanStreamInput(message, { action, controlVersion } = {}) {
    const command = `stream-${message?.type ?? 'unknown'}`
    const resource = this.#activeResource()
    const capability = ['text', 'key', 'reset'].includes(message?.type) ? 'browser.input' : 'browser.interact'
    const commandHash = sha256(message)
    const envelope = action ?? this.#signHuman({ capability, resource, operation: operationFor(command), commandHash })
    const expected = {
      actorId: this.humanId,
      sessionId: this.sessionId,
      capability,
      resource,
      operation: operationFor(command),
      commandHash,
    }
    if (!sameHumanAction(envelope?.payload, expected)) {
      return this.#recordBrowserAction(envelope?.payload?.actionId, command, 'human', this.humanId, resource, 'denied', 'ACTION_COMMAND_MISMATCH', undefined, this.realtimeAudit)
    }
    const decision = this.gateway.submitHuman({ action: envelope, audit: this.realtimeAudit })
    if (decision.status !== 'allowed') {
      this.#recordBrowserAction(decision.actionId, command, 'human', this.humanId, resource, 'denied', decision.reason, undefined, this.realtimeAudit)
      return decision
    }

    const lease = this.#control.authorize({ actorType: 'human', actorId: this.humanId, command })
    if (lease.status !== 'allowed') {
      this.#recordBrowserAction(decision.actionId, command, 'human', this.humanId, resource, 'denied', lease.reason, undefined, this.realtimeAudit)
      return lease
    }
    if (controlVersion !== this.#controlVersion || !this.#state?.running) {
      return this.#recordBrowserAction(decision.actionId, command, 'human', this.humanId, resource, 'denied', !this.#state?.running ? 'SESSION_SUSPENDED' : 'ACTION_REVALIDATION_REQUIRED', undefined, this.realtimeAudit)
    }
    try {
      await this.#executor.humanInput(message)
      return this.#recordBrowserAction(decision.actionId, command, 'human', this.humanId, resource, 'executed', undefined, undefined, this.realtimeAudit)
    } catch (error) {
      return this.#recordBrowserAction(decision.actionId, command, 'human', this.humanId, resource, 'failed', error.message, undefined, this.realtimeAudit)
    }
  }

  async suspend({ action } = {}) {
    const authorized = this.#authorizeHumanControlAction('suspend', action)
    if (authorized.status !== 'allowed') return this.#publicDecision(authorized)
    this.#controlVersion += 1
    this.#state = { ...this.#state, running: false }
    await this.releaseHumanInput()
    const result = await this.#executor.suspend()
    this.#state = { ...this.#state, running: false }
    this.#control.record('browser.session.suspended', { actorId: this.humanId })
    this.audit.append({
      kind: 'browser.session.suspended',
      sessionId: this.sessionId,
      actionId: authorized.actionId,
      actorType: 'human',
      actorId: this.humanId,
      at: new Date(this.now()).toISOString(),
    })
    return { ...this.#publicDecision(authorized), result }
  }

  async resume({ action } = {}) {
    const authorized = this.#authorizeHumanControlAction('resume', action)
    if (authorized.status !== 'allowed') return this.#publicDecision(authorized)
    this.#state = await this.#executor.start()
    this.#control.record('browser.session.resumed', { actorId: this.humanId })
    this.audit.append({
      kind: 'browser.session.resumed',
      sessionId: this.sessionId,
      actionId: authorized.actionId,
      actorType: 'human',
      actorId: this.humanId,
      at: new Date(this.now()).toISOString(),
    })
    return { ...this.#publicDecision(authorized), result: { resumed: true } }
  }

  async subscribeScreencast(onFrame) {
    return this.#executor.subscribeScreencast(onFrame)
  }

  allowTemporaryNavigation(url) {
    if (typeof this.#executor.allowTemporaryNavigation !== 'function') {
      throw new TypeError('browser executor does not support temporary navigation')
    }
    return this.#executor.allowTemporaryNavigation(url)
  }

  async close() {
    this.#controlVersion += 1
    this.#state = { ...this.#state, running: false }
    await this.releaseHumanInput()
    await this.#executor.suspend()
    this.#state = { ...this.#state, running: false }
  }

  #prepareCommand(input, actorType) {
    if (actorType !== 'human' && ['browser-files', 'upload-files', 'download-file'].includes(input?.command)) {
      return { status: 'denied', reason: 'HUMAN_BROWSER_FILES_ONLY' }
    }
    if (!input || !COMMANDS.has(input.command)) {
      const reason = !input?.command ? 'INVALID_COMMAND' : 'UNKNOWN_BROWSER_COMMAND'
      this.#recordBrowserAction(undefined, input?.command ?? 'unknown', actorType, actorType === 'human' ? this.humanId : this.agentId, this.#activeResource(), 'denied', reason)
      return { status: 'denied', reason }
    }
    let resource
    try {
      resource = input.url
        ? `browser:${this.agentId}:${redactSensitiveBrowserUrl(assertSafeBrowserUrl(input.url))}`
        : this.#activeResource()
    } catch (error) {
      this.#recordBrowserAction(undefined, input.command, actorType, actorType === 'human' ? this.humanId : this.agentId, `browser:${this.agentId}:invalid`, 'denied', error.message)
      return { status: 'denied', reason: error.message }
    }
    return { status: 'allowed', capability: capabilityFor(input.command), operation: operationFor(input.command), resource }
  }

  #activeResource() {
    const active = this.#state?.tabs?.find((tab) => tab.active)
    return `browser:${this.agentId}:${active?.url ?? 'about:blank'}`
  }

  #signHuman({ capability, resource, operation, commandHash }) {
    return signHumanAction({
      actionId: `browser-human-${crypto.randomUUID()}`,
      humanId: this.humanId,
      sessionId: this.sessionId,
      capability,
      resource,
      operation,
      ...(commandHash ? { commandHash } : {}),
      ...isoWindow(this.now()),
    }, this.humanIdentity)
  }

  #authorizeHumanControlAction(operation, action) {
    const resource = `browser:${this.agentId}:${this.sessionId}`
    const envelope = action ?? this.#signHuman({ capability: 'browser.control', resource, operation })
    const expected = {
      actorId: this.humanId,
      sessionId: this.sessionId,
      capability: 'browser.control',
      resource,
      operation,
    }
    if (!sameHumanAction(envelope?.payload, expected)) {
      const denied = { status: 'denied', actionId: envelope?.payload?.actionId ?? 'unknown', reason: 'CONTROL_ACTION_MISMATCH' }
      this.#recordControl(operation, envelope, denied)
      return denied
    }
    const decision = this.gateway.submitHuman({ action: envelope })
    if (decision.status !== 'allowed') this.#recordControl(operation, envelope, decision)
    return { ...decision, envelope }
  }

  #changeControl(operation, action) {
    const authorized = this.#authorizeHumanControlAction(operation, action)
    if (authorized.status !== 'allowed') return this.#publicDecision(authorized)
    const transition = operation === 'take_control'
      ? this.#control.takeHumanControl(this.humanId)
      : this.#control.returnControlToAgent(this.humanId)
    if (transition.status !== 'allowed') {
      const denied = { ...transition, actionId: authorized.actionId }
      this.#recordControl(operation, authorized.envelope, denied)
      return denied
    }
    this.#controlVersion += 1
    // Queue cleanup after any in-flight input and before the next controller's work.
    void this.releaseHumanInput()
    const result = { ...transition, actionId: authorized.actionId, auditHash: authorized.auditHash }
    this.#recordControl(operation, authorized.envelope, result)
    return result
  }

  #publicDecision({ envelope: _envelope, ...decision }) {
    return decision
  }

  #recordControl(operation, envelope, result) {
    const allowed = result.status === 'allowed'
    const kind = allowed
      ? operation === 'take_control' ? 'browser.control.taken' : 'browser.control.returned'
      : 'browser.control.rejected'
    this.audit.append({
      kind,
      sessionId: this.sessionId,
      actionId: result.actionId ?? envelope?.payload?.actionId ?? 'unknown',
      actorType: 'human',
      actorId: envelope?.payload?.humanId ?? 'unknown',
      authority: allowed ? envelope?.humanKeyId : 'unverified',
      operation,
      outcome: allowed ? 'allowed' : 'denied',
      ...(this.realtimeAudit !== this.audit && typeof this.realtimeAudit.head === 'function'
        ? {
            realtimeInputAudit: {
              entries: this.realtimeAudit.head().nextSeq,
              headHash: this.realtimeAudit.head().headHash,
            },
          }
        : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      at: new Date(this.now()).toISOString(),
    })
  }

  async #executeAuthorized({ actionId, actorType, actorId, command, resource, decision }) {
    const controlVersion = this.#controlVersion
    const lease = this.#control.authorize({ actorType, actorId, command: command.command })
    if (lease.status !== 'allowed') {
      this.#recordBrowserAction(actionId, command.command, actorType, actorId, resource, 'denied', lease.reason)
      return { status: 'denied', actionId, reason: lease.reason }
    }
    if (!this.#state?.running) {
      this.#recordBrowserAction(actionId, command.command, actorType, actorId, resource, 'denied', 'SESSION_SUSPENDED')
      return { status: 'denied', actionId, reason: 'SESSION_SUSPENDED' }
    }

    try {
      await this.#inputQueue
      const currentLease = this.#control.authorize({ actorType, actorId, command: command.command })
      if (currentLease.status !== 'allowed' || !this.#state?.running || controlVersion !== this.#controlVersion) {
        const reason = currentLease.status !== 'allowed' ? currentLease.reason : !this.#state?.running ? 'SESSION_SUSPENDED' : 'ACTION_REVALIDATION_REQUIRED'
        this.#recordBrowserAction(actionId, command.command, actorType, actorId, resource, 'denied', reason)
        return { status: 'denied', actionId, reason }
      }
      const result = await this.#execute(command)
      this.#state = await this.#executor.state()
      this.#control.record(`browser.${actorType}.${command.command}`, {
        actorId,
        ...(result?.url ? { url: result.url } : {}),
        ...(result?.characters ? { characters: result.characters } : {}),
      })
      this.#recordBrowserAction(actionId, command.command, actorType, actorId, resource, 'executed', undefined, result)
      return { ...decision, result }
    } catch (error) {
      this.#recordBrowserAction(actionId, command.command, actorType, actorId, resource, 'failed', error.message)
      return { status: 'denied', actionId, reason: error.message }
    }
  }

  async #execute(input) {
    if (['open-tab', 'activate-tab', 'close-tab', 'navigate', 'back', 'forward', 'reload'].includes(input.command)) await this.#executor.releaseHumanInput?.()
    if (input.command === 'browser-files') return this.#executor.browserFiles()
    if (input.command === 'upload-files') return this.#executor.uploadFiles(input.files)
    if (input.command === 'download-file') return this.#executor.downloadFile(input.downloadId)
    if (input.command === 'open-tab') return this.#executor.openTab(input.url)
    if (input.command === 'activate-tab') return this.#executor.activateTab(input.tabId)
    if (input.command === 'close-tab') return this.#executor.closeTab(input.tabId)
    if (input.command === 'navigate') return this.#executor.navigate(input.url, input.tabId)
    if (input.command === 'back') return this.#executor.goBack()
    if (input.command === 'forward') return this.#executor.goForward()
    if (input.command === 'reload') return this.#executor.reload()
    if (input.command === 'read') return this.#executor.read()
    if (input.command === 'snapshot') return this.#executor.snapshot()
    if (input.command === 'click') return this.#executor.click(input)
    if (input.command === 'type') return this.#executor.type(input)
    if (input.command === 'key') return this.#executor.key(input.key)
    if (input.command === 'scroll') return this.#executor.scroll(input.deltaY)
    throw new TypeError('UNKNOWN_BROWSER_COMMAND')
  }

  #recordBrowserAction(actionId, command, actorType, actorId, resource, outcome, reason, result, audit = this.audit) {
    const entry = audit.append({
      kind: 'browser.action',
      sessionId: this.sessionId,
      actionId: boundedString(actionId, 256) ? actionId : 'unassigned',
      actorType,
      actorId,
      command,
      resource,
      outcome,
      ...(reason ? { reason } : {}),
      ...(result?.url ? { resultingUrl: redactSensitiveBrowserUrl(result.url) } : {}),
      ...(result?.tabId ? { tabId: result.tabId } : {}),
      ...(Number.isInteger(result?.characters) ? { characters: result.characters } : {}),
      at: new Date(this.now()).toISOString(),
    })
    if (outcome === 'executed') return { status: 'allowed', actionId, auditHash: entry.entryHash }
    return { status: outcome === 'pending' ? 'pending' : 'denied', actionId, reason }
  }
}
