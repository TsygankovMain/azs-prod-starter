<script setup lang="ts">
const props = defineProps<{ done: number[]; late: number[] }>()
const W = 820; const H = 170; const pad = 22
const n = computed(() => props.done.length)
const gap = computed(() => n.value > 40 ? 1 : 3)
const bw = computed(() => (W - pad * 2) / Math.max(n.value, 1))
const maxVal = computed(() => Math.max(...props.done.map((d, i) => d + props.late[i]), 1))
const yOf = (v: number) => H - pad - v / maxVal.value * (H - pad * 2)
</script>
<template>
  <svg :viewBox="`0 0 ${W} ${H}`" width="100%">
    <template v-for="(d, i) in done" :key="i">
      <rect
        :x="(pad + i * bw).toFixed(1)"
        :y="(yOf(d) - (H - pad - yOf(late[i]))).toFixed(1)"
        :width="(bw - gap).toFixed(1)"
        :height="(H - pad - yOf(d)).toFixed(1)"
        fill="var(--b24-color-success, #1fa363)" rx="2"
      ><title>день {{ i + 1 }}: сдано {{ d }}</title></rect>
      <rect
        :x="(pad + i * bw).toFixed(1)"
        :y="yOf(late[i]).toFixed(1)"
        :width="(bw - gap).toFixed(1)"
        :height="(H - pad - yOf(late[i])).toFixed(1)"
        fill="var(--b24-color-danger, #e0533b)" rx="2"
      ><title>день {{ i + 1 }}: просрочено {{ late[i] }}</title></rect>
    </template>
    <line :x1="pad" :x2="W - pad" :y1="H - pad" :y2="H - pad" stroke="#e3e8ee"/>
  </svg>
</template>
