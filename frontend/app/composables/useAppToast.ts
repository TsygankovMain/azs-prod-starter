/**
 * Thin wrapper over @bitrix24/b24ui-nuxt useToast.
 * Provides a stable success/error/info API so pages don't depend on the library directly.
 *
 * b24ui useToast manages toasts via add()/remove(); duration is driven by
 * the B24Toaster :duration prop per-toast via the `duration` field.
 */

// b24ui's useToast is auto-imported by Nuxt from the library layer.
// We expose our wrapper as useAppToast to avoid colliding with the b24ui auto-import.
import { useToast as useB24Toast } from '#imports'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string | number
  kind: ToastKind
  text: string
}

const DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  error: 7000, // errors stay longer
}

const COLOR: Record<ToastKind, string> = {
  success: 'air-primary-success',
  error: 'air-primary-alert',
  info: 'air-primary',
}

export function useAppToast() {
  const toast = useB24Toast()

  function push(kind: ToastKind, text: string): void {
    toast.add({
      description: text,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- b24ui color union is generated from theme, not exported as a plain type
      color: COLOR[kind] as any,
      duration: DURATION[kind],
      close: true,
    })
  }

  return {
    /** Raw toast list from b24ui (reactive). */
    toasts: toast.toasts,
    success: (text: string) => push('success', text),
    error: (text: string) => push('error', text),
    info: (text: string) => push('info', text),
  }
}
