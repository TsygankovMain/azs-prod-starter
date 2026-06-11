/**
 * Promise-based confirmation dialog.
 *
 * Usage:
 *   const { confirm } = useConfirm()
 *   const ok = await confirm({ title: '…', text: '…', confirmLabel: '…' })
 *   if (!ok) return
 *
 * ConfirmDialog.vue reads { state } and calls answer(true|false).
 * Module-level state ensures a single dialog instance across the app.
 */
import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  text: string
  confirmLabel?: string
}

type ConfirmState = ConfirmOptions & { resolve: (ok: boolean) => void }

const state = ref<ConfirmState | null>(null)

export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      state.value = { ...options, resolve }
    })
  }

  function answer(ok: boolean) {
    state.value?.resolve(ok)
    state.value = null
  }

  return { state, confirm, answer }
}
