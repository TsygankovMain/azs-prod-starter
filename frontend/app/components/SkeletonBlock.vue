<script setup lang="ts">
/**
 * rounded — Tailwind-класс скругления (например 'rounded-[11px]');
 * передаётся в :class как есть; пустая строка = скругление по умолчанию темы B24Skeleton
 */
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
