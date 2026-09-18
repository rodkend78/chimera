import { useEffect, useMemo, useRef } from 'react'
import { Pause, RefreshCw } from 'lucide-react'
import { browserKey, browserPoint, createPointerInputController, createWheelInputScheduler } from './browser-stream-input.js'

export default function LiveViewport({ frame, streamStatus, humanControl, sendInput, suspended }) {
  const surface = useRef(null)
  const keys = useRef(new Map())
  const composing = useRef(false)
  const moveFrame = useRef(null)
  const pendingMove = useRef(null)
  const remoteHeld = useRef({ keys: new Set(), buttons: new Set() })
  const enabled = humanControl && !suspended && Boolean(frame.data)
  const current = useRef({ frame, enabled })
  current.current = { frame, enabled }
  const transmit = useMemo(() => (message) => {
    const held = remoteHeld.current
    if (message.type === 'reset') {
      // Mounts, passive views, and repeated blur/cleanup events have nothing to release.
      if (!held.keys.size && !held.buttons.size) return
      held.keys.clear()
      held.buttons.clear()
    } else if (message.type === 'key') {
      if (message.event === 'down') held.keys.add(message.key)
      else held.keys.delete(message.key)
    } else if (message.type === 'mouse') {
      if (message.event === 'pressed') held.buttons.add(message.button ?? 'left')
      else if (message.event === 'released') held.buttons.delete(message.button ?? 'left')
    }
    sendInput(message)
  }, [sendInput])
  const pointer = useMemo(() => createPointerInputController(transmit), [transmit])
  const wheel = useMemo(() => createWheelInputScheduler(transmit), [transmit])
  const coordinates = (event) => browserPoint(event, surface.current.getBoundingClientRect(), current.current.frame)
  const flushMove = () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
    moveFrame.current = null
    if (pendingMove.current) pointer.move(pendingMove.current)
    pendingMove.current = null
  }
  const reset = () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
    moveFrame.current = null
    pendingMove.current = null
    wheel.cancel()
    pointer.cancel()
    keys.current.clear()
    composing.current = false
    transmit({ type: 'reset' })
  }

  useEffect(() => {
    const element = surface.current
    const onWheel = (event) => {
      if (!current.current.enabled) return
      event.preventDefault()
      wheel.push(event, coordinates(event), current.current.frame.height)
    }
    // React's delegated wheel listener is passive in Chromium.
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => { element.removeEventListener('wheel', onWheel); wheel.cancel() }
  }, [wheel])

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) reset() }
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', onVisibility)
      reset()
    }
  }, [pointer, wheel, transmit])
  useEffect(() => { if (!enabled) reset() }, [enabled])

  const onKeyDown = (event) => {
    if (!enabled || event.isComposing || composing.current || event.key === 'Process' || event.key === 'Dead') return
    // Let the local browser deliver clipboard text through onPaste.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') return
    event.preventDefault()
    if (!event.metaKey && !event.ctrlKey && !event.altKey && [...event.key].length === 1 && /[^\x20-\x7e]/.test(event.key)) {
      transmit({ type: 'text', text: event.key })
      return
    }
    const key = browserKey(event)
    keys.current.set(event.code || key, key)
    transmit({ type: 'key', event: 'down', key })
  }
  const onKeyUp = (event) => {
    const id = event.code || browserKey(event)
    const key = keys.current.get(id)
    if (!key) return
    event.preventDefault()
    keys.current.delete(id)
    transmit({ type: 'key', event: 'up', key })
  }

  return (
    <div
      ref={surface}
      className={`live-viewport ${humanControl ? 'interactive' : ''}`}
      tabIndex={enabled ? 0 : -1}
      style={{ touchAction: 'none' }}
      aria-label={humanControl ? 'Live browser, human control active' : 'Live browser, agent control active'}
      onPointerDown={(event) => {
        if (!enabled || !event.isPrimary) return
        surface.current.focus({ preventScroll: true })
        flushMove()
        pointer.down(coordinates(event), event.button)
        surface.current.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!enabled || !event.isPrimary) return
        pendingMove.current = coordinates(event)
        if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(flushMove)
      }}
      onPointerUp={(event) => {
        if (!enabled || !event.isPrimary) return
        flushMove()
        pointer.up(coordinates(event))
        if (surface.current.hasPointerCapture(event.pointerId)) surface.current.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={reset}
      onLostPointerCapture={() => pointer.cancel()}
      onClick={(event) => { if (enabled) pointer.click(coordinates(event), event.button, event.detail) }}
      onAuxClick={(event) => {
        if (!enabled || event.button !== 1) return
        event.preventDefault()
        pointer.click(coordinates(event), 1, event.detail)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        if (enabled) pointer.click(coordinates(event), 2)
      }}
      onBlur={reset}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={(event) => {
        if (!enabled) return
        event.preventDefault()
        const text = event.clipboardData.getData('text/plain')
        if (text && text.length <= 65_536) transmit({ type: 'text', text })
      }}
      onCompositionStart={() => { composing.current = true }}
      onCompositionEnd={(event) => {
        composing.current = false
        if (enabled && event.data) transmit({ type: 'text', text: event.data })
      }}
    >
      {frame.data && !suspended ? <img src={`data:image/jpeg;base64,${frame.data}`} alt="Live Chromium page" draggable="false" /> : null}
      {!frame.data && !suspended ? <div className="viewport-loading"><RefreshCw size={24} /><span>{streamStatus}</span></div> : null}
      {suspended ? <div className="viewport-loading suspended"><Pause size={28} /><strong>Browser suspended</strong><span>Tabs and profile are preserved.</span></div> : null}
      {humanControl && !suspended ? <span className="human-input-hint">Human input active</span> : null}
    </div>
  )
}
