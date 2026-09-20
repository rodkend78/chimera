import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const appSource = await readFile(new URL('../app/src/App.jsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../app/src/styles.css', import.meta.url), 'utf8')
const navigationSource = await readFile(new URL('../app/src/WorkspaceNavigation.jsx', import.meta.url), 'utf8')

test('primary navigation is controlled and opens a real main workspace view', () => {
  assert.match(appSource, /<WorkspaceNavigation activeSection=\{activeSection\}/)
  assert.match(navigationSource, /onClick=\{\(\) => onNavigate\(id\)\}/)
  assert.match(navigationSource, /aria-current=\{id === activeSection \? 'page' : undefined\}/)
  assert.match(appSource, /const \[activeSection, setActiveSection\] = useState\('Queue'\)/)

  for (const section of ['Queue', 'Media', 'Activity', 'Decisions']) {
    assert.match(appSource, new RegExp(`activeSection === '${section}'`))
  }
  assert.match(navigationSource, /\['Queue', 'Work', ClipboardList\]/)
  assert.doesNotMatch(appSource, /\['Conversations'/)
  assert.doesNotMatch(appSource, /\['Tasks'/)
})

test('the Media view exposes real Stability image and Luma video generation workflows', () => {
  assert.match(appSource, /function MediaStudio/)
  assert.match(appSource, /Stability Image/)
  assert.match(appSource, /Luma Video/)
  assert.match(appSource, /\/api\/media\/generate/)
  assert.match(appSource, /\/api\/media\/status/)
  assert.match(appSource, /<img[^>]+generated image/)
  assert.match(appSource, /<video[^>]+controls/)
  assert.match(styles, /\.media-studio/)
})

test('the operating canvas keeps task planning visible and accepts work from one command dock', () => {
  assert.match(appSource, /function TaskPlan\(\{ state \}\)/)
  assert.match(appSource, />Task plan</)
  assert.match(appSource, /Give RJ one bounded objective/)
  assert.match(appSource, /className="command-dock"/)
  assert.match(appSource, /RJ's queue · one bounded objective/)
  assert.match(appSource, /onKeyDown=\{onKeyDown\}/)
  assert.match(appSource, /ArrowUp/)
  assert.match(appSource, /ArrowDown/)
  assert.match(styles, /\.command-dock/)
  assert.match(styles, /--canvas: #f4f6f8/)
  assert.doesNotMatch(appSource, /function TaskComposer/)
  assert.doesNotMatch(appSource, /team-chat-composer/)
})

test('the Queue navigation view is history, not a second inbox', () => {
  assert.match(appSource, /function QueueView\(\{ state, onConnectCodex, refresh, notify, onNavigate, onOutcomeAction, roomAddress, setRoomAddress \}\)/)
  assert.match(appSource, /<TaskWorkspace[\s\S]*onOutcomeAction=\{onOutcomeAction\}/)
  assert.match(appSource, /eyebrow="RJ's queue"/)
  assert.match(appSource, /title="What are we working on\?"/)
  assert.match(appSource, /message box below/)
  assert.match(appSource, /state\.conversations\?\.channels/)
  assert.match(appSource, /task-room/)
  assert.match(appSource, /Verified event|Derived event/)
  // Transcript following and reading continuity are covered by rendered behavior tests.
  assert.match(styles, /\.queue-region/)
  assert.match(styles, /\.section-region \{ grid-area: browser;/)
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.section-region/)
})

test('the Agents view reports model-provider and GitHub connection state with honest Hermes intake', () => {
  assert.match(appSource, /function AgentsView\(\{ settingsOnly = false, state, refresh, onNavigate,[^)]*onAgentModel, onConnectGitHub \}\)/)
  assert.match(appSource, /<AntigravityConnection provider=\{providers.find\(provider => provider.id === 'antigravity'\)\} refresh=\{refresh\}/)
  assert.match(appSource, /state\.models\?\.providers/)
  assert.match(appSource, /state\.agents\?\.specialists/)
  assert.match(appSource, /function AgentImportPanel/)
  assert.match(appSource, /Find Hermes agents/)
  assert.match(appSource, /configured Hermes source/)
  assert.match(appSource, /CHIMERA_HERMES_INSTANCE_ID/)
  assert.match(appSource, /set \$\{HERMES_INSTANCE_ENV\} to import from a configured Hermes source|set CHIMERA_HERMES_INSTANCE_ID to import from a configured Hermes source/)
  assert.match(appSource, /HERMES_DISCOVERY_NOT_CONFIGURED/)
  assert.match(appSource, /Import selected/)
  assert.match(appSource, /\/api\/agents\/discover/)
  assert.match(appSource, /\/api\/agents\/import/)
  assert.match(appSource, /\/api\/agents\/main\/import/)
  assert.match(appSource, /Import RJ continuity/)
  assert.match(appSource, /candidate\.dependencyStatus/)
  assert.match(appSource, /\/api\/agents\/workers\/\$\{action\}/)
  assert.match(appSource, /\/api\/agents\/remove/)
  assert.match(appSource, /Connect GitHub/)
  assert.match(appSource, /\/api\/github\/auth\/login/)
  assert.match(appSource, /Remove .* from team/)
  assert.match(appSource, /Start worker/)
  assert.match(appSource, /Recover/)
  assert.match(appSource, />RJ</)
  assert.match(appSource, /profiles=\{state\.agents\.accessProfiles\}/)
  assert.match(appSource, /function AgentAccessControls/)
  assert.match(appSource, /<AgentAccessControls\s+agent=\{agent\}/)
  assert.match(appSource, /agent\.access\.description/)
  assert.match(appSource, /\/api\/agents\/access/)
  assert.match(appSource, /subscription connected/)
  assert.match(appSource, /approved route/)
  assert.match(appSource, /function ModelCatalog/)
  assert.match(appSource, /Search Bedrock models/)
  assert.match(appSource, /image-generation/)
  assert.match(appSource, /video-generation/)
  assert.match(appSource, /model\.adapter === 'ready'/)
  assert.match(appSource, />Open Media</)
  assert.match(appSource, /\/api\/models\/check/)
  assert.match(styles, /\.model-catalog/)
  assert.match(styles, /\.agent-import-panel/)
})

test('catalog-only conversation models select without claiming access verification', () => {
  assert.match(appSource, /onClick=\{\(\) => run\(model, onModelSelect\)\}/)
  assert.match(appSource, /ready \? 'Use model' : 'Select model'/)
  assert.match(appSource, /Catalog only · not verified/)
  assert.doesNotMatch(appSource, /ready \? 'Use model' : 'Check & use'/)
})

test('imported specialists do not offer Start unless an RJ task owns them', () => {
  assert.match(appSource, /ownedByTaskId/)
  assert.match(appSource, /Runs under an RJ task/)
  assert.match(appSource, /not as an independent daemon/)
  assert.match(appSource, /startAvailable = !imported \|\| owned/)
})

test('every agent has an independent Auto, Preferred, or Pinned conversation-model picker', () => {
  assert.match(appSource, /function AgentModelPicker/)
  assert.match(appSource, /Chimera Auto/)
  assert.match(appSource, /Allow a backup model/)
  assert.match(appSource, /Only use this model/)
  assert.match(appSource, /capabilities\?\.includes\('conversation'\)/)
  assert.match(appSource, /\/api\/agents\/model/)
  assert.match(appSource, /<AgentModelPicker[\s\S]+agent=\{state\.agents\.main\}/)
  assert.match(appSource, /<AgentModelPicker[\s\S]+agent=\{agent\}/)
  assert.match(styles, /\.agent-model-picker/)
})

test('the RJ loop uses a durable conversation endpoint and renders linked human and RJ messages', () => {
  assert.match(appSource, /\/api\/conversations\/messages/)
  assert.match(appSource, /state\.conversations\?\.messages/)
  assert.match(appSource, /message\.senderAgentId/)
  assert.match(styles, /\.conversation-message/)
})

test('the decisions rail stays the approval surface and can collapse', () => {
  assert.match(appSource, /function RightRail\(\{ state, onDecision, railCollapsed \}\)/)
  assert.match(appSource, /if \(railCollapsed\) return null/)
  assert.match(appSource, /Expand decisions rail/)
  assert.match(appSource, /No decisions waiting/)
  assert.match(styles, /\.app-shell\.rail-collapsed/)
})

test('the approval dialog shows exact semantic targets before consequential actions', () => {
  assert.match(appSource, /decision\.actionDiff\?\.review/)
  assert.match(appSource, /Object\.entries\(review\.fields\)/)
  assert.match(appSource, /Expected head SHA/)
  assert.match(appSource, /decision\.agent\?\.agentId/)
  assert.match(styles, /\.decision-review/)
})
