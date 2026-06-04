<script setup lang="ts">
const props = defineProps<{
  parts: Array<{ n: number; color: string }>
  total: number
  height?: number
}>()
const W = 560
const H = computed(() => props.height || 34)
const rects = computed(() => {
  let x = 0
  return props.parts.map(p => {
    const w = props.total ? (p.n / props.total) * W : 0
    const rect = { x, w: Math.max(0, w - 2), color: p.color, n: p.n }
    x += w
    return rect
  }).filter(r => r.w > 0)
})
</script>
<template>
  <svg :viewBox="`0 0 ${W} ${H}`" width="100%" :height="H" preserveAspectRatio="none">
    <rect v-if="!rects.length" :width="W" :height="H" rx="6" fill="#eef2f6"/>
    <rect
      v-for="(r, i) in rects" :key="i"
      :x="r.x" y="0" :width="r.w" :height="H" rx="6"
      :fill="r.color"
    ><title>{{ r.n }}</title></rect>
  </svg>
</template>
