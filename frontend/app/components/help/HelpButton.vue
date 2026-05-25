<script setup lang="ts">
import { ref } from 'vue'

interface Props {
  defaultRole?: 'admin' | 'reviewer' | 'settings'
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  defaultRole: 'admin',
  label: 'Справка'
})

const { open } = useHelpDrawer()

const handleClick = () => {
  open(props.defaultRole)
}
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center justify-center w-8 h-8 rounded-full border border-gray-300 bg-white hover:bg-gray-50 active:bg-gray-100 transition-colors"
    :aria-label="label"
    @click="handleClick"
  >
    <span class="text-xl font-semibold text-gray-600 select-none">?</span>
  </button>
</template>
