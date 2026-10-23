import { createApp, defineComponent, h } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import './assets/modal-card.css'
import './assets/modal-footer-btn.css'
import { appLog } from './utils/appLog'
import { setUnauthorizedHandler } from './utils/api'
import { handleUnauthorized, refreshAuth, useAuth } from './composables/useAuth'
import { installUiWatchers } from './composables/useUi'
import LoginView from './components/LoginView.vue'
import ToastHost from './components/common/ToastHost.vue'
import ConfirmHost from './components/common/ConfirmHost.vue'

// A 401 anywhere means the session cookie expired (or the password was changed
// on another device). Flip the app back to the login screen instead of letting
// every panel show its own "not authenticated" error.
setUnauthorizedHandler(handleUnauthorized)

installUiWatchers()

/**
 * Root: auth gate + the app shell.
 *
 * The login view is mounted as a sibling of the shell rather than inside it so
 * the shell's watchers (dock geometry, back handlers) are never installed while
 * signed out — a stray back handler would otherwise swallow the hardware back
 * button on the login screen.
 */
const Root = defineComponent({
  name: 'Root',
  setup() {
    const { isAuthenticated, status } = useAuth()
    return () => {
      // `null` = still checking; render nothing rather than flashing the login
      // form for a moment on every reload.
      if (status.value === null) return null
      if (!isAuthenticated.value) {
        return h(LoginView, { onSuccess: () => { void refreshAuth() } })
      }
      return h(App)
    }
  },
})

const app = createApp(Root)
app.use(i18n)
app.mount('#app')

// Toast/confirm hosts live outside the gate: the login screen shows errors too.
const overlays = document.createElement('div')
overlays.id = 'overlays'
document.body.appendChild(overlays)
createApp({
  render: () => [h(ToastHost), h(ConfirmHost)],
}).use(i18n).mount(overlays)

void refreshAuth().then(() => {
  appLog.i('Boot', 'auth status resolved')
})

// A page restored from the back/forward cache was frozen: sockets may have died
// without a close event, so treat it as a resume.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) void refreshAuth()
})

window.addEventListener('error', (e) => {
  appLog.e('Window', e.message, e.filename, e.lineno)
})

window.addEventListener('unhandledrejection', (e) => {
  appLog.e('Window', 'unhandled rejection', String(e.reason))
})
