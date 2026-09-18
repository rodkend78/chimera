const BUTTONS = new Map([
  [0, 'left'],
  [1, 'middle'],
  [2, 'right'],
])

export function browserPoint(event, rect, frame) {
  const scale = Math.min(rect.width / frame.width, rect.height / frame.height)
  const renderedWidth = frame.width * scale
  const renderedHeight = frame.height * scale
  const offsetX = (rect.width - renderedWidth) / 2
  const offsetY = (rect.height - renderedHeight) / 2
  return {
    x: Math.max(0, Math.min(frame.width - 1, (event.clientX - rect.left - offsetX) / scale)),
    y: Math.max(0, Math.min(frame.height - 1, (event.clientY - rect.top - offsetY) / scale)),
  }
}

export function pointerClickMessage(point, button = 0, clickCount = 1) {
  return {
    type: 'click',
    x: point.x,
    y: point.y,
    button: BUTTONS.get(button) ?? 'left',
    ...(clickCount > 1 ? { clickCount: Math.min(3, clickCount) } : {}),
  }
}

// Keep ordinary clicks atomic; a press is forwarded only once movement becomes a drag.
export function createPointerInputController(send, dragThreshold = 3) {
  let pending = null
  let dragging = false
  let suppressClick = false
  const mouse = (event, point, button = 0) => send({ type: 'mouse', event, ...point, button: BUTTONS.get(button) ?? 'left' })
  return {
    down(point, button = 0) {
      pending = { ...point, button }
      dragging = false
      suppressClick = false
    },
    move(point) {
      if (pending && !dragging && Math.hypot(point.x - pending.x, point.y - pending.y) >= dragThreshold) {
        mouse('pressed', { x: pending.x, y: pending.y }, pending.button)
        dragging = true
      }
      if (!pending || dragging) mouse('moved', point, pending?.button)
    },
    up(point) {
      if (dragging) {
        mouse('released', point, pending.button)
        suppressClick = true
      }
      pending = null
      dragging = false
    },
    click(point, button = 0, clickCount = 1) {
      if (suppressClick) { suppressClick = false; return }
      send(pointerClickMessage(point, button, clickCount))
    },
    cancel() {
      if (!pending) return
      if (dragging) send({ type: 'reset' })
      pending = null
      dragging = false
      suppressClick = true
    },
  }
}

export function browserKey(event) {
  return event.key === ' ' ? 'Space' : event.key
}

export function createWheelInputScheduler(send, schedule = (callback) => globalThis.requestAnimationFrame(callback), cancelSchedule = (handle) => globalThis.cancelAnimationFrame(handle)) {
  if (typeof send !== 'function' || typeof schedule !== 'function' || typeof cancelSchedule !== 'function') {
    throw new TypeError('wheel input scheduler requires callable dependencies')
  }
  let handle = null
  let deltaX = 0
  let deltaY = 0
  let point = { x: 0, y: 0 }

  const flush = () => {
    handle = null
    const message = { type: 'wheel', ...point, deltaX, deltaY }
    deltaX = 0
    deltaY = 0
    send(message)
  }

  return {
    push(event, coordinates = { x: 0, y: 0 }, frameHeight = 900) {
      const unit = event?.deltaMode === 1 ? 16 : event?.deltaMode === 2 ? frameHeight : 1
      deltaX += (Number(event?.deltaX) || 0) * unit
      deltaY += (Number(event?.deltaY) || 0) * unit
      point = coordinates
      if (handle === null) handle = schedule(flush)
    },
    cancel() {
      if (handle !== null) cancelSchedule(handle)
      handle = null
      deltaX = 0
      deltaY = 0
    },
  }
}
