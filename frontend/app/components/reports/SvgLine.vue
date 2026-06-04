<script setup lang="ts">
const props = defineProps<{ data: number[]; minV?: number; maxV?: number; color?: string }>()
const W = 820; const H = 200; const pad = 28
const minV = computed(() => props.minV ?? 40)
const maxV = computed(() => props.maxV ?? 100)
const color = computed(() => props.color || 'var(--b24-color-link, #2a6bd4)')
const xOf = (i: number) => pad + i * (W - pad * 2) / Math.max(props.data.length - 1, 1)
const yOf = (v: number) => H - pad - (v - minV.value) / (maxV.value - minV.value) * (H - pad * 2)
const linePath = computed(() => props.data.map((v, i) => `${i ? 'L' : 'M'} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' '))
const areaPath = computed(() => {
  const n = props.data.length - 1
  return props.data.map((v, i) => `${i ? 'L' : 'M'} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)}`).join(' ')
    + ` L ${xOf(n)} ${H - pad} L ${xOf(0)} ${H - pad} Z`
})
const gridLines = [50, 60, 70, 80, 90, 100]
const dots = computed(() => props.data
  .map((v, i) => ({ i, v, show: props.data.length <= 31 || i % 3 === 0 || i === props.data.length - 1 }))
  .filter(d => d.show)
)
</script>
<template>
  <svg :viewBox="`0 0 ${W} ${H}`" width="100%" overflow="visible">
    <defs>
      <linearGradient id="svgline-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" :stop-color="color" stop-opacity="0.22"/>
        <stop offset="1" :stop-color="color" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <line v-for="g in gridLines" :key="g" :x1="pad" :x2="W-pad" :y1="yOf(g)" :y2="yOf(g)" stroke="#eef2f6"/>
    <text v-for="g in gridLines" :key="'t'+g" x="2" :y="yOf(g)+4" font-size="10" fill="#9aa7b5">{{ g }}</text>
    <path :d="areaPath" fill="url(#svgline-grad)"/>
    <path :d="linePath" fill="none" :stroke="color" stroke-width="2.5" stroke-linejoin="round"/>
    <circle
      v-for="d in dots" :key="d.i"
      :cx="xOf(d.i).toFixed(1)" :cy="yOf(d.v).toFixed(1)"
      r="3" fill="#fff" :stroke="color" stroke-width="2"
    ><title>день {{ d.i + 1 }}: {{ d.v }}%</title></circle>
  </svg>
</template>
