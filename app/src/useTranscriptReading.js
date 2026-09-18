import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// Reading position belongs to a conversation in the loaded workspace. Only the
// transcript scrolls; scrollIntoView would also move its workspace ancestors.
export function useTranscriptReading(roomId, positions) {
  const transcript = useRef(null)
  const latest = useRef(true)
  const [atLatest, setAtLatest] = useState(true)
  const remember = useCallback(() => {
    const node = transcript.current
    if (!node || !roomId) return
    const following = node.scrollHeight - node.clientHeight - node.scrollTop <= 32
    const { top, bottom } = node.getBoundingClientRect()
    const anchor = [...node.querySelectorAll('[data-message-id]')].find(row => {
      const bounds = row.getBoundingClientRect()
      return bounds.bottom > top + 1 && bounds.top < bottom
    })
    positions.current.set(roomId, { following, scrollTop: node.scrollTop,
      anchorId: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 })
    if (latest.current !== following) { latest.current = following; setAtLatest(following) }
  }, [positions, roomId])
  const restore = useCallback(() => {
    const node = transcript.current
    if (!node || !roomId) return
    const saved = positions.current.get(roomId)
    if (!saved || saved.following) node.scrollTop = node.scrollHeight
    else {
      const anchor = [...node.querySelectorAll('[data-message-id]')].find(row => row.dataset.messageId === saved.anchorId)
      if (anchor) node.scrollTop += anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset
      else node.scrollTop = saved.scrollTop
    }
    remember()
  }, [positions, remember, roomId])
  // Reconcile after content changes, including edits to an existing message.
  useLayoutEffect(restore)
  useLayoutEffect(() => {
    const node = transcript.current
    if (!node) return undefined
    const observer = new ResizeObserver(restore)
    observer.observe(node)
    return () => observer.disconnect()
  }, [restore])
  const jumpToLatest = () => {
    if (!transcript.current || !roomId) return
    transcript.current.scrollTop = transcript.current.scrollHeight
    remember()
  }
  return { transcript, onScroll: remember, atLatest, jumpToLatest }
}
