<script setup lang="ts">
import { DateTime } from 'luxon'

const apiStore = useApiStore()
type PeriodKey = '7' | '30' | '90'
const period = ref<PeriodKey>('30')
const rows = ref<Array<{ azsId: string; azsTitle?: string | null; total: number; onTime: number; late: number; avgMinutes: number | null; pct: number }>>([])
const loading = ref(false); const error = ref('')
type SortKey = 'pct' | 'onTime' | 'late' | 'total' | 'avg'
const sort = reactive<{ k: SortKey; dir: 1 | -1 }>({ k: 'pct', dir: -1 })

const load = async () => {
  const now = DateTime.utc()
  const days = Number(period.value)
  const dateFrom = now.minus({ days: days - 1 }).toISODate()
  const dateTo   = now.toISODate()
  loading.value = true; error.value = ''
  try {
    const resp = await apiStore.getReportsRating({ dateFrom, dateTo })
    rows.value = resp.items
  } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка загрузки' }
  finally { loading.value = false }
}

const sorted = computed(() => {
  const k = sort.k
  const sortFn = (a: typeof rows.value[0], b: typeof rows.value[0]) => {
    const va = k === 'avg' ? (a.avgMinutes ?? 9999) : k === 'pct' ? a.pct : k === 'onTime' ? a.onTime : k === 'late' ? a.late : a.total
    const vb = k === 'avg' ? (b.avgMinutes ?? 9999) : k === 'pct' ? b.pct : k === 'onTime' ? b.onTime : k === 'late' ? b.late : b.total
    return (va - vb) * sort.dir
  }
  return [...rows.value].sort(sortFn)
})

const toggleSort = (k: SortKey) => {
  if (sort.k === k) sort.dir = sort.dir === 1 ? -1 : 1
  else { sort.k = k; sort.dir = k === 'late' || k === 'avg' ? 1 : -1 }
}

const pctColor = (p: number) => p >= 90 ? '#1fa363' : p >= 75 ? '#e0a020' : '#e0533b'

onMounted(load)
watch(period, load)
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h1 class="text-[21px] font-semibold">Рейтинг дисциплины АЗС</h1>
        <p class="text-sm text-gray-500 mt-0.5">Кто стабильно держит порядок, а кому нужна поддержка</p>
      </div>
      <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: агрегация dispatch_log по АЗС</span>
    </div>

    <div class="flex gap-2.5 mb-4 flex-wrap">
      <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm">
        <button v-for="p in ['7','30','90']" :key="p"
          :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
          @click="period = p as PeriodKey"
        >{{ p }} дней</button>
      </div>
      <span class="text-[12px] text-gray-400 self-center">Клик по заголовку столбца — сортировка</span>
    </div>

    <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
    <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
    <div v-else class="bg-white border border-gray-200 rounded-[14px] shadow-sm overflow-x-auto">
      <table class="w-full text-[13px] border-collapse">
        <thead>
          <tr>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">#</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">АЗС</th>
            <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('total')">Всего {{ sort.k === 'total' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
            <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('onTime')">Вовремя {{ sort.k === 'onTime' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
            <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('late')">Просроч. {{ sort.k === 'late' ? (sort.dir === 1 ? '↑' : '↓') : '' }}</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('pct')">% вовремя {{ sort.k === 'pct' ? (sort.dir === -1 ? '↓' : '↑') : '' }}</th>
            <th class="text-right text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100 cursor-pointer hover:text-blue-600 select-none" @click="toggleSort('avg')">Ср. время {{ sort.k === 'avg' ? (sort.dir === 1 ? '↑' : '↓') : '' }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, idx) in sorted" :key="row.azsId" class="hover:bg-gray-50">
            <td class="px-3 py-2.5 border-b border-gray-50 text-gray-400 tabular-nums">{{ idx + 1 }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50">
              <b class="block">{{ row.azsTitle || `АЗС ${row.azsId}` }}</b>
              <span class="text-[12px] text-gray-400">ID {{ row.azsId }}</span>
            </td>
            <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums">{{ row.total }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums text-green-700">{{ row.onTime }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums" :style="row.late ? 'color:#e0533b' : 'color:#9aa7b5'">{{ row.late }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50">
              <div class="flex items-center gap-2 min-w-[130px]">
                <div class="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div class="h-full rounded-full" :style="`width:${row.pct}%;background:${pctColor(row.pct)}`"/>
                </div>
                <b class="tabular-nums min-w-[38px] text-right" :style="`color:${pctColor(row.pct)}`">{{ row.pct }}%</b>
              </div>
            </td>
            <td class="px-3 py-2.5 border-b border-gray-50 text-right tabular-nums text-gray-500">
              {{ row.avgMinutes !== null ? `${row.avgMinutes} мин` : '—' }}
            </td>
          </tr>
          <tr v-if="!sorted.length">
            <td colspan="7" class="text-center py-8 text-gray-400">Нет данных за выбранный период</td>
          </tr>
        </tbody>
      </table>
      <p class="text-[12px] text-gray-400 px-3 py-2">«Ср. время» — среднее от уведомления (scheduled_at) до сдачи (updated_at) только по сданным отчётам.</p>
    </div>
  </div>
</template>
