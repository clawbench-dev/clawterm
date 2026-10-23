<template>
  <Teleport to="body">
    <Transition name="menu-fade" @after-leave="emit('after-leave')">
      <div
        v-if="show"
        ref="menuEl"
        class="popup-menu"
        :class="{ 'popup-menu--app': appSurface }"
        role="menu"
        :style="menuStyle"
        @click.stop="emit('update:show', false)"
        @keydown.escape="emit('update:show', false)"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<script lang="ts">
// Module scope: a counter in `<script setup>` runs once per INSTANCE, which
// would hand every menu the same id and make the registered back-handlers
// indistinguishable.
let menuSeq = 0
function nextMenuSeq() {
  return ++menuSeq
}
</script>

<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { registerBackHandler, PRIORITY_OVERLAY } from '@/composables/useUi'

const props = withDefaults(defineProps<{
  show: boolean
  targetElement?: HTMLElement | null
  maxWidth?: number
  maxHeight?: number
  edgeMargin?: number
  /** Estimated row count, used to decide whether to flip above the anchor. */
  menuItemsCount?: number
  anchor?: 'left' | 'right' | 'auto'
  appSurface?: boolean
}>(), {
  targetElement: null,
  maxWidth: 240,
  maxHeight: 320,
  edgeMargin: 8,
  menuItemsCount: 8,
  anchor: 'auto',
  appSurface: false,
})

const emit = defineEmits<{ 'update:show': [v: boolean]; 'after-leave': [] }>()

const instanceSeq = nextMenuSeq()
const menuEl = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

/**
 * Position the menu against its anchor.
 *
 * `position: fixed` does not mean "viewport coordinates": an ancestor with a
 * transform (or `will-change: transform`) becomes the containing block, and a
 * CSS `zoom` on <html> scales the offsets. Reading only the viewport rect and
 * writing it to top/left therefore lands the menu tens of pixels off in those
 * cases. The menu's own measured box tells us which one applies, and a
 * sanity check on the result falls back to the plain conversion.
 */
function updatePosition() {
  const anchor = props.targetElement
  if (!anchor) {
    menuStyle.value = {}
    return
  }
  const r = anchor.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const m = props.edgeMargin
  const el = menuEl.value

  // Measured size when laid out, estimate otherwise (first frame).
  const w = el && el.offsetWidth > 0 ? el.offsetWidth : props.maxWidth
  const h = el && el.offsetHeight > 0 ? el.offsetHeight : Math.min(props.maxHeight, props.menuItemsCount * 36 + 8)

  // Horizontal: prefer aligning the left edges, flip to right-aligned when that
  // would overflow.
  let left = props.anchor === 'right' ? r.right - w : r.left
  if (props.anchor === 'auto' && left + w > vw - m) left = r.right - w
  left = Math.max(m, Math.min(left, vw - m - w))

  // Vertical: below the anchor unless that overflows and there is more room
  // above (a menu opened from a bottom dock must open upward).
  const spaceBelow = vh - r.bottom - m
  const spaceAbove = r.top - m
  let top: number
  let placement: 'below' | 'above'
  if (h <= spaceBelow || spaceBelow >= spaceAbove) {
    top = Math.min(r.bottom + 4, vh - m - h)
    placement = 'below'
  } else {
    top = Math.max(m, r.top - h - 4)
    placement = 'above'
  }

  // Convert viewport coordinates into the element's containing block when one
  // exists. Probing with the LIVE element would flash it at the wrong place,
  // so probe with a clone that inherits the same ancestor chain.
  const block = measureContainingBlock(el)
  let style: Record<string, string>
  if (block) {
    style = {
      position: 'fixed',
      top: `${top - block.top}px`,
      left: `${left - block.left}px`,
      maxWidth: `${props.maxWidth}px`,
      maxHeight: `${Math.min(props.maxHeight, vh - 2 * m)}px`,
      overflowY: props.appSurface ? 'hidden' : 'auto',
    }
  } else {
    style = {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      maxWidth: `${props.maxWidth}px`,
      maxHeight: `${Math.min(props.maxHeight, vh - 2 * m)}px`,
      overflowY: props.appSurface ? 'hidden' : 'auto',
    }
  }
  // A containing block whose measurement is implausible (transformed ancestor
  // mid-transition, zero-size box) would put the menu off screen; the plain
  // viewport conversion is exact whenever nothing transforms.
  if (block && (top - block.top < 0 || left - block.left < 0)) {
    style.top = `${Math.max(m, Math.min(top, vh - m - h))}px`
    style.left = `${Math.max(m, Math.min(left, vw - m - w))}px`
  }
  void placement
  menuStyle.value = style
}

interface BlockRect { top: number; left: number }

/**
 * Find the containing block of a fixed-position element, if it is not the
 * viewport. Returns viewport-relative origin, or null for the normal case.
 *
 * A transformed ancestor makes `fixed` behave like `absolute` relative to it.
 * The probe clones the element, pins it at the block's origin with the same
 * styles, and reads where it actually lands — which is the only reliable way to
 * discover this without walking and re-implementing the browser's rules.
 */
function measureContainingBlock(el: HTMLElement | null): BlockRect | null {
  if (!el || typeof document === 'undefined') return null
  // Walk up for a transform/filter/perspective/will-change ancestor. This is
  // the cheap structural check; the clone probe below only runs when one is
  // found, so the common case costs one loop over a handful of nodes.
  let node: HTMLElement | null = el.parentElement
  let hasBlock = false
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.perspective !== 'none'
      || (cs.willChange && /transform|perspective|filter/.test(cs.willChange))
      || cs.contain.includes('paint')) {
      hasBlock = true
      break
    }
    node = node.parentElement
  }
  if (!hasBlock) return null

  const clone = el.cloneNode(true) as HTMLElement
  clone.style.position = 'fixed'
  clone.style.top = '0px'
  clone.style.left = '0px'
  clone.style.right = 'auto'
  clone.style.bottom = 'auto'
  clone.style.visibility = 'hidden'
  clone.style.pointerEvents = 'none'
  el.parentElement?.appendChild(clone)
  const rect = clone.getBoundingClientRect()
  clone.remove()
  // A clone that lands at (0,0) means the block IS the viewport (or the
  // measurement failed); both are handled by the plain path.
  if (Math.abs(rect.top) < 0.5 && Math.abs(rect.left) < 0.5) return null
  return { top: rect.top, left: rect.left }
}

function handleClickOutside(e: MouseEvent) {
  const anchor = props.targetElement
  if (!anchor) return
  if (anchor.contains(e.target as Node)) return
  if ((e.target as HTMLElement).closest?.('.popup-menu')) return
  emit('update:show', false)
}

function onLayoutChange() {
  if (props.show) updatePosition()
}

function bind() {
  window.addEventListener('scroll', onLayoutChange, true)
  window.addEventListener('resize', onLayoutChange)
  // A soft keyboard changes the VISUAL viewport without a window resize on
  // iOS/PWA, so the menu must follow that too.
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onLayoutChange)
    window.visualViewport.addEventListener('scroll', onLayoutChange)
  }
  // Defer: the click that opened the menu is still propagating.
  setTimeout(() => {
    if (props.show) document.addEventListener('click', handleClickOutside)
  }, 0)
}

function unbind() {
  window.removeEventListener('scroll', onLayoutChange, true)
  window.removeEventListener('resize', onLayoutChange)
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', onLayoutChange)
    window.visualViewport.removeEventListener('scroll', onLayoutChange)
  }
  document.removeEventListener('click', handleClickOutside)
}

function schedulePosition() {
  // One frame later: the element is inside a Transition and has no layout yet,
  // and a keyboard dismissal triggered by the same tap can begin first.
  requestAnimationFrame(() => {
    if (props.show) updatePosition()
  })
}

watch(
  () => props.show,
  (v) => {
    if (v) {
      schedulePosition()
      bind()
    } else {
      unbind()
    }
  },
)

// The anchor element can be swapped while the menu is open (a view switching
// between a phone and a tablet layout). Reposition when it changes, otherwise
// the menu stays pinned to the removed element's last rect.
watch(() => props.targetElement, () => {
  if (props.show) schedulePosition()
})

onMounted(() => {
  if (props.show) {
    schedulePosition()
    bind()
  }
})

let unregisterBack: (() => void) | null = null

watch(
  () => props.show,
  (v) => {
    if (v && !unregisterBack) {
      // Same tier as dialogs: equal priority resolves by registration order,
      // which reproduces "the thing opened last wins".
      unregisterBack = registerBackHandler({
        id: `popup-menu-${instanceSeq}`,
        canGoBack: () => props.show,
        goBack: () => emit('update:show', false),
        priority: PRIORITY_OVERLAY + 1,
      })
    } else if (!v && unregisterBack) {
      unregisterBack()
      unregisterBack = null
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  unregisterBack?.()
  unbind()
})
</script>

<style scoped>
.popup-menu {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.12);
  z-index: var(--z-popover);
  padding: 0;
}

.menu-fade-enter-active,
.menu-fade-leave-active {
  transition: opacity var(--duration-base) ease, transform var(--duration-base) ease;
}

.menu-fade-enter-from,
.menu-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.popup-menu--app {
  background: var(--bg-primary);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  padding: 3px 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>
