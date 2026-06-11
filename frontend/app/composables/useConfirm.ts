/**
 * Promise-based confirmation dialog.
 *
 * Public API  — use in pages/components:
 *   const { confirm } = useConfirm()
 *   const ok = await confirm({ title: '…', text: '…', confirmLabel: '…' })
 *   if (!ok) return
 *
 * Internal API — use only in ConfirmDialog.vue:
 *   const { state, answer } = useConfirmDialogState()
 *
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

/** Public API: call confirm() from pages and components. */
export function useConfirm() {
  function confirm(options: ConfirmOptions): Promise<boolean> {
    state.value?.resolve(false) // защита от зависшего await при перезаписи диалога
    return new Promise((resolve) => {
      state.value = { ...options, resolve }
    })
  }

  return { confirm }
}

/** Internal API: used exclusively by ConfirmDialog.vue. */
export function useConfirmDialogState() {
  function answer(ok: boolean) {
    state.value?.resolve(ok)
    state.value = null
  }

  return { state, answer }
}
