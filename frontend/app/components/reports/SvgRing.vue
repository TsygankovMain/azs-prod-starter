<script setup lang="ts">
const props = defineProps<{ pct: number; color?: string; size?: number }>()
const R = 54
const C = 2 * Math.PI * R
const off = computed(() => C * (1 - Math.max(0, Math.min(100, props.pct)) / 100))
const color = computed(() => props.color || 'var(--b24-color-success, #1fa363)')
const sz = computed(() => props.size || 128)
</script>
<template>
  <div class="relative" :style="`width:${sz}px;height:${sz}px`">
    <svg :viewBox="`0 0 ${sz} ${sz}`" :width="sz" :height="sz">
      <circle :cx="sz/2" :cy="sz/2" :r="R" fill="none" stroke="#eef2f6" stroke-width="14"/>
      <circle
        :cx="sz/2" :cy="sz/2" :r="R" fill="none" :stroke="color" stroke-width="14"
        stroke-linecap="round"
        :stroke-dasharray="C"
        :stroke-dashoffset="off"
        :transform="`rotate(-90 ${sz/2} ${sz/2})`"
      />
    </svg>
    <div class="absolute inset-0 flex flex-col items-center justify-center">
      <b class="text-[30px] font-extrabold tracking-tight">{{ pct }}%</b>
      <span class="text-[11.5px] text-gray-400">вовремя</span>
    </div>
  </div>
</template>
