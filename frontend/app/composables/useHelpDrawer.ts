import { ref, type Ref } from 'vue'

type HelpRole = 'admin' | 'reviewer' | 'settings'

interface HelpDrawerState {
  isOpen: Ref<boolean>
  defaultRole: Ref<HelpRole>
  open: (role: HelpRole) => void
  close: () => void
}

export const useHelpDrawer = (): HelpDrawerState => {
  const isOpen = useState<boolean>('help-drawer-isOpen', () => false)
  const defaultRole = useState<HelpRole>('help-drawer-defaultRole', () => 'admin')

  const open = (role: HelpRole) => {
    defaultRole.value = role
    isOpen.value = true
  }

  const close = () => {
    isOpen.value = false
  }

  return {
    isOpen,
    defaultRole,
    open,
    close
  }
}
