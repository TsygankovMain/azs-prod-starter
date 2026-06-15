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

export type ToastKind = 'success' | 'error' | 'info' | 'warning'

/**
 * Passthrough options for toast.add().
 * `actions` uses a structural type because b24ui's ButtonProps is generated from theme config
 * and cannot be imported cleanly from outside the library layer.
 */
export type ToastOptions = {
  title?: string
  actions?: { label: string; onClick?: () => void; [key: string]: unknown }[]
}

const DURATION: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 7000, // errors stay longer
}

const COLOR: Record<ToastKind, string> = {
  success: 'air-primary-success',
  error: 'air-primary-alert',
  info: 'air-primary',
  warning: 'air-primary-warning',
}

export function useAppToast() {
  const toast = useB24Toast()

  function push(kind: ToastKind, text: string, options?: ToastOptions): void {
    toast.add({
      description: text,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- b24ui color union is generated from theme, not exported as a plain type
      color: COLOR[kind] as any,
      duration: DURATION[kind],
      close: true,
      ...options,
    })
  }

  return {
    success: (text: string, options?: ToastOptions) => push('success', text, options),
    error: (text: string, options?: ToastOptions) => push('error', text, options),
    info: (text: string, options?: ToastOptions) => push('info', text, options),
    warning: (text: string, options?: ToastOptions) => push('warning', text, options),
  }
}
