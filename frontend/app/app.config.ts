export default defineAppConfig({
  b24ui: {
    modal: {
      slots: {
        overlay: 'fixed inset-0 bg-[#003366]/20 z-[200]',
        content: 'light bg-(--popup-window-background-color) fixed flex flex-col gap-[20px] focus:outline-none p-[24px] pt-[20px] z-[200]'
      }
    }
  },
  colorMode: false,
  colorModeTypeLight: 'light' as const // edge-dark | edge-light | light
})
