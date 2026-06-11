<script setup lang="ts">
withDefaults(defineProps<{ height?: string; width?: string; rounded?: string }>(), {
  height: '1rem',
  width: '100%',
  rounded: '',
})
</script>

<template>
  <B24Skeleton
    :class="['block', rounded]"
    :style="{ height, width }"
  />
</template>
