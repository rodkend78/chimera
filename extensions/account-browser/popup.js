const el = id => document.getElementById(id)
let targets = []
async function send(message) {
  el('error').textContent = ''
  try { const response = await chrome.runtime.sendMessage(message); if (response.error) throw new Error(response.error); return response }
  catch { el('error').textContent = 'Request refused. Check Chimera, pairing, the selected page and consent.'; return null }
}
function render(state) {
  if (!state) return
  el('status').textContent = state.status
  el('sharing').hidden = state.status !== 'Paired'; el('pair-section').hidden = state.status === 'Paired'
  el('disconnect').hidden = state.status === 'Disconnected'
  el('challenge-panel').hidden = !state.pairing
  el('pairing-id').textContent = state.pairing?.pairingId || ''; el('challenge').textContent = state.pairing?.challenge || ''
  el('leases').replaceChildren(); el('empty').hidden = state.leases.length > 0
  for (const lease of state.leases) {
    const row = document.createElement('li'); const label = document.createElement('span'); const stop = document.createElement('button')
    label.textContent = `Shared read-only · ${lease.origin} · ${lease.taskId} / ${lease.agentId} · expires ${new Date(lease.expiresAt).toLocaleTimeString()}`
    stop.textContent = 'Stop sharing'; stop.addEventListener('click', async () => render(await send({ type: 'stop', leaseId: lease.leaseId })))
    row.append(label, stop); el('leases').append(row)
  }
}
async function refresh() {
  const response = await send({ type: 'targets' }); if (!response) return
  targets = response.targets; el('target').replaceChildren(new Option('Choose a recipient', ''))
  targets.forEach((t, i) => el('target').append(new Option(`${t.taskId} / ${t.agentId}`, String(i))))
  eligibility()
}
function eligibility() { el('share').disabled = !el('acknowledge').checked || el('target').value === '' }
el('pair').addEventListener('click', async () => render(await send({ type: 'pair' })))
el('finish').addEventListener('click', async () => { const state = await send({ type: 'finish-pairing' }); render(state); if (state?.status === 'Paired') await refresh() })
el('refresh').addEventListener('click', refresh)
el('disconnect').addEventListener('click', async () => render(await send({ type: 'disconnect' })))
el('acknowledge').addEventListener('change', eligibility); el('target').addEventListener('change', eligibility)
el('share').addEventListener('click', async () => {
  const target = targets[Number(el('target').value)]; if (!target || !el('acknowledge').checked || el('target').value === '') return
  render(await send({ type: 'share', ...target, acknowledged: true })); el('acknowledge').checked = false; eligibility()
})
const initial = await send({ type: 'state' }); render(initial); if (initial?.status === 'Paired') await refresh()
setInterval(async () => render(await send({ type: 'state' })), 2000)
