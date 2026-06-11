<script setup lang="ts">
/**
 * ConfirmDialog — global confirm dialog, mounted once in app.vue.
 * Reads from useConfirm().state and resolves the pending promise via answer().
 *
 * B24Modal handles:
 *  - Teleport to body (portal=true by default)
 *  - Overlay / backdrop
 *  - Esc key and click-outside-to-close (dismissible=true by default)
 */
import { nextTick, watch } from 'vue'

const { state, answer } = useConfirm()

const isOpen = computed(() => state.value !== null)

// Focus the cancel button when the dialog opens for keyboard accessibility
const cancelButtonRef = ref<{ $el?: HTMLElement } | null>(null)

watch(isOpen, (val) => {
  if (val) {
    nextTick(() => {
      const el = cancelButtonRef.value?.$el
      const target = el && el.tagName === 'BUTTON' ? el : el?.querySelector?.('button')
      ;(target as HTMLElement | null | undefined)?.focus?.()
    })
  }
})

// B24Modal emits update:open with false when user presses Esc or clicks outside
function onUpdateOpen(val: boolean) {
  if (!val) {
    answer(false)
  }
}
</script>

<template>
  <B24Modal
    :open="isOpen"
    :title="state?.title"
    :description="state?.text"
    :dismissible="true"
    role="dialog"
    :aria-modal="true"
    @update:open="onUpdateOpen"
  >
    <template #footer="{ close: modalClose }">
      <div class="flex justify-end gap-2 pt-2">
        <B24Button
          ref="cancelButtonRef"
          color="air-secondary-no-accent"
          variant="solid"
          label="Отмена"
          @click="() => { answer(false); modalClose() }"
        />
        <B24Button
          color="air-primary"
          variant="solid"
          :label="state?.confirmLabel ?? 'Подтвердить'"
          @click="() => { answer(true); modalClose() }"
        />
      </div>
    </template>
  </B24Modal>
</template>
