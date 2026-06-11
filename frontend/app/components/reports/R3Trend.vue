<script setup lang="ts">
import { DateTime } from 'luxon'

const apiStore = useApiStore()
type PeriodKey = '7' | '30' | '90'
const period = ref<PeriodKey>('30')
type TRow = { date: string; total: number; done: number; expired: number; open: number }
const rows = ref<TRow[]>([])
const loading = ref(false); const error = ref('')

const load = async () => {
  const now = DateTime.utc()
  const days = Number(period.value)
  loading.value = true; error.value = ''
  try {
    const resp = await apiStore.getReportsTrend({
      dateFrom: now.minus({ days: days - 1 }).toISODate(),
      dateTo: now.toISODate()
    })
    rows.value = resp.items
  } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
  finally { loading.value = false }
}

const pctData = computed(() => rows.value.map(r => r.total ? Math.round(r.done / r.total * 100) : 0))
const doneData = computed(() => rows.value.map(r => r.done))
const lateData = computed(() => rows.value.map(r => r.expired))

const callout = computed(() => {
  const p = pctData.value
  if (p.length < 2) return null
  const first = p[0]; const last = p[p.length - 1]; const delta = last - first
  return { first, last, delta, days: period.value }
})

onMounted(load)
watch(period, load)
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h1 class="text-[21px] font-semibold">Динамика дисциплины</h1>
        <p class="text-sm text-gray-500 mt-0.5">Как меняется доля отчётов, сданных вовремя</p>
      </div>
    </div>

    <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm mb-4">
      <button v-for="p in ['7','30','90']" :key="p"
        :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
        @click="period = p as PeriodKey"
      >{{ p }} дней</button>
    </div>

    <template v-if="loading">
      <!-- Скелетон первого графика (SvgLine, H≈200px + заголовок + callout-зона) -->
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
        <SkeletonBlock height="1rem" width="50%" class="mb-3" />
        <SkeletonBlock height="200px" rounded="rounded-xl" />
        <SkeletonBlock height="3rem" width="100%" rounded="rounded-xl" class="mt-3.5" />
      </div>
      <!-- Скелетон второго графика (SvgGroupBars, H≈170px + заголовок + легенда) -->
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
        <SkeletonBlock height="1rem" width="50%" class="mb-3" />
        <SkeletonBlock height="170px" rounded="rounded-xl" />
        <div class="flex gap-3.5 mt-3">
          <SkeletonBlock height="0.75rem" width="4rem" />
          <SkeletonBlock height="0.75rem" width="4rem" />
        </div>
      </div>
    </template>
    <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
    <template v-else>
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
        <h3 class="font-semibold mb-1">Доля сданных вовремя, %</h3>
        <SvgLine :data="pctData" />
        <div v-if="callout" class="mt-3.5 bg-green-50 border border-green-200 rounded-xl p-3 text-[13px] text-green-800 flex gap-2.5 items-start">
          <span class="text-[18px] leading-none">📈</span>
          <div>Дисциплина <b>{{ callout.delta >= 0 ? 'выросла' : 'снизилась' }}</b> с <b>{{ callout.first }}%</b> до <b>{{ callout.last }}%</b> за {{ callout.days }} дней.</div>
        </div>
      </div>
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
        <h3 class="font-semibold mb-3">Сдано и просрочено по дням</h3>
        <SvgGroupBars :done="doneData" :late="lateData" />
        <div class="flex gap-3.5 mt-3 text-[12px] text-gray-500">
          <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 mr-1.5 align-[-1px]"/>Сдано</span>
          <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-red-400 mr-1.5 align-[-1px]"/>Просрочено</span>
        </div>
      </div>
    </template>
  </div>
</template>
