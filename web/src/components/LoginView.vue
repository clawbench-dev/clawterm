<template>
  <div class="login-view">
    <div class="login-card">
      <div class="login-brand">
        <div class="login-logo">
          <TerminalSquare :size="28" />
        </div>
        <h1 class="login-title">{{ t('login.title') }}</h1>
        <p class="login-subtitle">{{ t('login.subtitle') }}</p>
      </div>

      <p v-if="needsSetup" class="login-hint">{{ t('login.setupHint') }}</p>

      <form class="login-form" @submit.prevent="submit">
        <label class="login-label">{{ needsSetup ? t('login.setupTitle') : t('login.password') }}</label>
        <input
          ref="pwdRef"
          v-model="password"
          class="login-input"
          type="password"
          autocomplete="current-password"
          :placeholder="t('login.passwordPlaceholder')"
          data-field="password"
        />

        <template v-if="needsSetup">
          <label class="login-label">{{ t('login.confirmPassword') }}</label>
          <input
            v-model="confirmPassword"
            class="login-input"
            type="password"
            autocomplete="new-password"
            :placeholder="t('login.confirmPlaceholder')"
            data-field="confirm"
          />
        </template>

        <p v-if="error" class="login-error">{{ error }}</p>

        <button class="login-submit" type="submit" :disabled="busy">
          <LoadingIndicator v-if="busy" size="sm" inline />
          <span>{{ needsSetup ? t('login.setAndEnter') : t('login.signIn') }}</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { TerminalSquare } from 'lucide-vue-next'
import { useAuth } from '@/composables/useAuth'
import LoadingIndicator from '@/components/common/LoadingIndicator.vue'

const emit = defineEmits<{ success: [] }>()
const { t } = useI18n()
const { needsSetup, login } = useAuth()

const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const busy = ref(false)
const pwdRef = ref<HTMLInputElement | null>(null)

const setup = computed(() => needsSetup.value)

onMounted(() => {
  // Focus without scrolling: on a phone the browser would otherwise pan the
  // fixed layout when the keyboard opens.
  nextTick(() => pwdRef.value?.focus({ preventScroll: true }))
})

async function submit() {
  error.value = ''
  if (setup.value) {
    if (password.value.length < 4) {
      error.value = t('login.tooShort')
      return
    }
    if (password.value !== confirmPassword.value) {
      error.value = t('login.mismatch')
      return
    }
  } else if (!password.value) {
    error.value = t('login.wrong')
    return
  }

  busy.value = true
  try {
    // `set` is the CHANGE-password flag; first-run setup is recognised by the
    // server's needsSetup state, so it must be false here.
    await login(password.value, false)
    password.value = ''
    confirmPassword.value = ''
    emit('success')
  } catch (err) {
    // A 401 is a wrong password; anything else is a real failure and must say
    // so rather than blaming the user's typing.
    const msg = err instanceof Error ? err.message : String(err)
    error.value = /401|not authenticated|wrong/i.test(msg) ? t('login.wrong') : `${t('login.failed')}: ${msg}`
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.login-view {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
  background: var(--bg-primary);
  /* Soft radial accent glow: reads as depth without introducing a colour that
     is not in the theme. */
  background-image: radial-gradient(
    circle at 50% 0%,
    color-mix(in srgb, var(--accent-color) 12%, transparent),
    transparent 60%
  );
}

.login-card {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.login-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.login-logo {
  width: 56px;
  height: 56px;
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--accent-color) 16%, transparent);
  color: var(--accent-color);
}

.login-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
}

.login-subtitle {
  font-size: var(--font-size-md);
  color: var(--text-muted);
}

.login-hint {
  font-size: var(--font-size-sm);
  line-height: var(--line-height-relaxed);
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--space-4) var(--space-5);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.login-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  margin-top: var(--space-2);
}

.login-input {
  width: 100%;
  height: 42px;
  padding: 0 var(--space-5);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-secondary);
  color: var(--text-primary);
  /* 16px: anything smaller makes mobile Safari zoom the page on focus. */
  font-size: 16px;
  outline: none;
  transition: border-color var(--duration-base);
}

.login-input:focus {
  border-color: var(--accent-color);
}

.login-error {
  font-size: var(--font-size-sm);
  color: var(--color-red);
  line-height: var(--line-height-snug);
}

.login-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  height: 44px;
  margin-top: var(--space-4);
  border: none;
  border-radius: var(--radius-sm);
  background: var(--accent-color);
  color: #fff;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: opacity var(--duration-base);
}

.login-submit:disabled {
  opacity: var(--opacity-muted);
  cursor: default;
}

.login-submit:active:not(:disabled) {
  transform: scale(0.99);
}
</style>
