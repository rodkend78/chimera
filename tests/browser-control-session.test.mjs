import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserControlSession } from '../src/browser-control-session.mjs'

function session() {
  return new BrowserControlSession({
    sessionId: 'browser-ceo-1',
    agentId: 'ceo',
    now: () => Date.parse('2026-08-22T17:00:00.000Z'),
  })
}

test('assigned agent initially controls tabs', () => {
  const browser = session()
  const opened = browser.dispatch({
    actorType: 'agent',
    actorId: 'ceo',
    command: 'open-tab',
    url: 'https://example.com/',
  })

  assert.equal(opened.status, 'allowed')
  assert.equal(browser.snapshot().tabs.length, 2)
  assert.equal(browser.snapshot().activeTabId, opened.tabId)
})

test('human takeover blocks agent input but preserves session state', () => {
  const browser = session()
  const first = browser.dispatch({
    actorType: 'agent',
    actorId: 'ceo',
    command: 'open-tab',
    url: 'https://example.com/research',
  })

  assert.equal(browser.takeHumanControl('rod').status, 'allowed')
  const rejected = browser.dispatch({
    actorType: 'agent',
    actorId: 'ceo',
    command: 'navigate',
    tabId: first.tabId,
    url: 'https://example.com/agent-input',
  })
  assert.deepEqual(rejected, { status: 'denied', reason: 'HUMAN_CONTROL_ACTIVE' })

  const humanNavigation = browser.dispatch({
    actorType: 'human',
    actorId: 'rod',
    command: 'navigate',
    tabId: first.tabId,
    url: 'https://example.com/human-input',
  })
  assert.equal(humanNavigation.status, 'allowed')
  assert.equal(browser.snapshot().tabs.find((tab) => tab.tabId === first.tabId).url, 'https://example.com/human-input')
})

test('only the controlling human can return control to the agent', () => {
  const browser = session()
  browser.takeHumanControl('rod')

  assert.deepEqual(
    browser.returnControlToAgent('another-human'),
    { status: 'denied', reason: 'CONTROL_OWNER_MISMATCH' },
  )
  assert.equal(browser.returnControlToAgent('rod').status, 'allowed')
  assert.deepEqual(browser.snapshot().controller, { type: 'agent', id: 'ceo' })
})

test('closing the final tab leaves a blank browser tab', () => {
  const browser = session()
  const onlyTab = browser.snapshot().activeTabId
  const result = browser.dispatch({
    actorType: 'agent',
    actorId: 'ceo',
    command: 'close-tab',
    tabId: onlyTab,
  })

  assert.equal(result.status, 'allowed')
  assert.equal(browser.snapshot().tabs.length, 1)
  assert.equal(browser.snapshot().tabs[0].url, 'about:blank')
})

test('control and rejected commands are recorded as activity events', () => {
  const browser = session()
  browser.takeHumanControl('rod')
  browser.dispatch({
    actorType: 'agent',
    actorId: 'ceo',
    command: 'open-tab',
    url: 'https://example.com/',
  })

  assert.deepEqual(
    browser.events().map((event) => event.kind),
    ['browser.session.created', 'browser.control.taken', 'browser.command.rejected'],
  )
})

test('malformed tab commands fail closed instead of throwing', () => {
  const browser = session()
  assert.doesNotThrow(() => {
    assert.deepEqual(
      browser.dispatch({ actorType: 'agent', actorId: 'ceo', command: 'open-tab', url: '' }),
      { status: 'denied', reason: 'INVALID_URL' },
    )
  })
})

test('authorization can guard executor input without mutating tab state', () => {
  const browser = session()
  assert.equal(
    browser.authorize({ actorType: 'agent', actorId: 'ceo', command: 'click' }).status,
    'allowed',
  )
  browser.takeHumanControl('rod')
  assert.deepEqual(
    browser.authorize({ actorType: 'agent', actorId: 'ceo', command: 'click' }),
    { status: 'denied', reason: 'HUMAN_CONTROL_ACTIVE' },
  )
})
