<template>
  <div
    class="loading-indicator"
    :class="[`size-${size}`, { inline, overlay, fixed, 'is-center': center }]"
    role="status"
    aria-live="polite"
  >
    <div class="li-spinner" aria-hidden="true"></div>
    <span v-if="label" class="li-label">{{ label }}</span>
    <slot />
  </div>
</template>

<script setup lang="ts">
/**
 * The one spinner in the app.
 *
 * The ring itself (`.li-spinner`, its size tiers and `@keyframes li-spin`) is
 * declared GLOBALLY in css/components.css because some callers inject HTML
 * strings (`v-html`, `innerHTML`, `::after`), and injected elements never carry
 * a `data-v-*` attribute — a scoped rule would silently miss them.
 */
withDefaults(
  defineProps<{
    label?: string
    size?: 'sm' | 'md' | 'lg'
    inline?: boolean
    overlay?: boolean
    fixed?: boolean
    center?: boolean
  }>(),
  {
    label: undefined,
    size: 'md',
    inline: false,
    overlay: false,
    fixed: false,
    center: true,
  },
)
</script>

<style scoped>
.loading-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-5);
  box-sizing: border-box;
  font-size: var(--font-size-md);
}

.li-label {
  color: var(--text-muted);
}

.loading-indicator:not(.inline) {
  flex-direction: column;
  padding: var(--space-9) var(--space-7);
  min-height: 80px;
}

.loading-indicator.overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: var(--bg-primary);
  opacity: var(--opacity-hover);
}

.loading-indicator.fixed {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  background: var(--bg-primary);
  opacity: var(--opacity-hover);
}

.loading-indicator.inline {
  padding: 0;
  min-height: 0;
}

.loading-indicator.is-center {
  justify-content: center;
}

/* A gentle glow lifts the loader off busy backgrounds. Scoped is safe here:
   only this component renders the `.overlay`/`.fixed` wrapper. */
.loading-indicator.overlay .li-spinner,
.loading-indicator.fixed .li-spinner {
  filter: drop-shadow(0 4px 14px color-mix(in srgb, var(--li-color, var(--accent-color)) 25%, transparent));
}
</style>
