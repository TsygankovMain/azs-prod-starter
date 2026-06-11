<script setup lang="ts">
import { DateTime } from 'luxon'

type PeriodKey = 'today' | 'yest' | '7' | '30' | 'custom'

const apiStore = useApiStore()
const period  = ref<PeriodKey>('today')
const customFrom = ref(''); const customTo = ref('')
const azsFilter = ref<string[]>([])
const azsOptions = ref<Array<{ value: string; label: string }>>([])
const azsOptionsError = ref(false)
const azsOptionsLoading = ref(false)

type SummaryType = { total: number; done: number; expired: number; open: number; failed: number; overdue: number; byStatus: Record<string, number> }
type ReportItem = {
  id: number; azsId: string; azsTitle?: string | null; adminUserId: number; status: string
  scheduledAt: string | null; deadlineAt: string | null; updatedAt: string | null; diskFolderId: number | null
}
const summary = ref<SummaryType>({ total: 0, done: 0, expired: 0, open: 0, failed: 0, overdue: 0, byStatus: {} })
const items   = ref<ReportItem[]>([])
const loading = ref(false)
const error   = ref('')

const computeRange = () => {
  const now = DateTime.utc()
  if (period.value === 'today') return { from: now.toISODate(), to: now.toISODate() }
  if (period.value === 'yest')  { const y = now.minus({ days: 1 }); return { from: y.toISODate(), to: y.toISODate() } }
  if (period.value === '7')     return { from: now.minus({ days: 6 }).toISODate(), to: now.toISODate() }
  if (period.value === '30')    return { from: now.minus({ days: 29 }).toISODate(), to: now.toISODate() }
  return { from: customFrom.value, to: customTo.value }
}

const load = async () => {
  const range = computeRange()
  if (!range.from || !range.to) return
  loading.value = true; error.value = ''
  try {
    const [r, s] = await Promise.all([
      apiStore.getReports({ dateFrom: range.from, dateTo: range.to, limit: 500 }),
      apiStore.getReportsSummary({ dateFrom: range.from, dateTo: range.to })
    ])
    items.value   = r.items
    summary.value = s.summary
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Ошибка загрузки'
  } finally {
    loading.value = false
  }
}

const displayItems = computed(() => {
  if (!azsFilter.value.length) return items.value
  return items.value.filter(i => azsFilter.value.includes(i.azsId))
})

const pct = computed(() => summary.value.total ? Math.round(summary.value.done / summary.value.total * 100) : 0)

const STATUS_LABEL: Record<string, string> = {
  done: 'Сдано', expired: 'Просрочено', in_progress: 'В работе', new: 'Ожидает', failed: 'Ошибка', reserved: 'Резерв'
}
const STATUS_COLOR: Record<string, string> = {
  done: 'text-green-700 bg-green-50', expired: 'text-red-700 bg-red-50',
  in_progress: 'text-yellow-700 bg-yellow-50', new: 'text-gray-500 bg-gray-100',
  failed: 'text-gray-600 bg-gray-100'
}
const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'

const loadAzsOptions = async () => {
  if (azsOptionsLoading.value) return
  azsOptionsLoading.value = true
  try {
    const resp = await apiStore.getAzsOptions({ limit: 500 })
    azsOptions.value = resp.items.map(i => ({ value: String(i.id), label: i.title || `АЗС ${i.id}` }))
    azsOptionsError.value = false
  } catch {
    azsOptionsError.value = true
  } finally {
    azsOptionsLoading.value = false
  }
}

onMounted(async () => {
  await loadAzsOptions()
  await load()
})
watch(period, load)
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h1 class="text-[21px] font-semibold">Сводка за день</h1>
        <p class="text-sm text-gray-500 mt-0.5">Операционный статус прохождения отчётов по всем АЗС</p>
      </div>
      <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: dispatch_log · getSummary + list</span>
    </div>

    <!-- Фильтры -->
    <div class="flex gap-2.5 flex-wrap mb-4">
      <div class="inline-flex bg-white border border-gray-200 rounded-[10px] p-0.5 shadow-sm">
        <button v-for="(lbl, k) in ({ today: 'Сегодня', yest: 'Вчера', '7': '7 дней', '30': '30 дней' } as Record<string, string>)" :key="k"
          :class="['px-3 py-1.5 rounded-lg font-semibold text-[12.5px] transition-colors', period === k ? 'bg-blue-600 text-white' : 'text-gray-500 hover:bg-gray-100']"
          @click="period = k as PeriodKey; load()"
        >{{ lbl }}</button>
      </div>
      <!-- AZS multi-select -->
      <div class="flex flex-col gap-1">
        <B24InputMenu
          v-model="azsFilter"
          :items="azsOptions"
          value-attribute="value"
          option-attribute="label"
          multiple
          placeholder="Все АЗС"
          class="min-w-[180px]"
        />
        <div v-if="azsOptionsError" class="flex items-center gap-1.5 text-[12px] text-red-600">
          <span>Список АЗС не загрузился</span>
          <button class="underline hover:no-underline disabled:opacity-50" :disabled="azsOptionsLoading" @click="loadAzsOptions">Повторить</button>
        </div>
      </div>
    </div>

    <!-- KPI cards -->
    <div class="grid grid-cols-2 lg:grid-cols-5 gap-3.5 mb-3.5">
      <div v-for="kpi in ([
        { t: 'Запланировано', v: summary.total,   s: 'слотов',           cls: 'border-blue-400',  vc: 'text-blue-600'  },
        { t: 'Сдано',         v: summary.done,    s: 'отчётов',          cls: 'border-green-500', vc: 'text-green-600' },
        { t: 'Просрочено',    v: summary.expired, s: 'не сдано в срок',  cls: 'border-red-400',   vc: 'text-red-600'   },
        { t: 'В работе',      v: summary.open,    s: 'открыто сейчас',   cls: 'border-yellow-400',vc: 'text-yellow-600'},
        { t: 'Ошибки',        v: summary.failed,  s: 'сбой отправки',    cls: 'border-gray-400',  vc: 'text-gray-500'  },
      ])" :key="kpi.t"
        :class="['bg-white border border-gray-200 border-l-4 rounded-[14px] shadow-sm p-4', kpi.cls]"
      >
        <div class="text-[12px] text-gray-400 font-semibold uppercase tracking-[0.4px]">{{ kpi.t }}</div>
        <div :class="['text-[30px] font-extrabold mt-1.5 tracking-tight', kpi.vc]">{{ kpi.v }}</div>
        <div class="text-[12px] text-gray-400 mt-0.5">{{ kpi.s }}</div>
      </div>
    </div>

    <!-- Ring + Stack row -->
    <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3.5 mb-3.5">
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
        <h3 class="font-semibold text-[14.5px] mb-3.5">Выполнение</h3>
        <div class="flex items-center gap-4">
          <SvgRing :pct="pct" />
          <div>
            <div class="text-[12px] text-gray-400">Сдано вовремя</div>
            <div class="font-bold text-[15px] mt-0.5">{{ summary.done }} из {{ summary.total }} АЗС</div>
            <div class="flex flex-col gap-1.5 mt-3 text-[12px] text-gray-500">
              <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-green-500 mr-1.5 align-[-1px]"/>Сдано</span>
              <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-400 mr-1.5 align-[-1px]"/>В работе</span>
              <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-red-400 mr-1.5 align-[-1px]"/>Просрочено</span>
              <span><i class="inline-block w-2.5 h-2.5 rounded-sm bg-gray-300 mr-1.5 align-[-1px]"/>Ожидает</span>
            </div>
          </div>
        </div>
      </div>
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
        <h3 class="font-semibold text-[14.5px] mb-3.5">Распределение по статусам</h3>
        <SvgStackBar :parts="[
          { n: summary.done,    color: '#1fa363' },
          { n: summary.open - (summary.byStatus?.new ?? 0), color: '#e0a020' },
          { n: summary.expired, color: '#e0533b' },
          { n: summary.byStatus?.new ?? 0, color: '#9aa7b5' },
        ]" :total="summary.total" />
        <div class="flex gap-3.5 flex-wrap mt-3 text-[12px] text-gray-500">
          <span v-for="(c, s) in ({ Сдано: '#1fa363', 'В работе': '#e0a020', Просрочено: '#e0533b', Ожидает: '#9aa7b5' } as Record<string, string>)" :key="s">
            <i class="inline-block w-2.5 h-2.5 rounded-sm mr-1.5 align-[-1px]" :style="`background:${c}`"/>{{ s }}
          </span>
        </div>
      </div>
    </div>

    <!-- Таблица -->
    <div v-if="loading" class="bg-white border border-gray-200 rounded-[14px] shadow-sm overflow-hidden">
      <!-- Шапка таблицы-скелетон -->
      <div class="flex gap-3 px-3 py-2.5 border-b border-gray-100">
        <SkeletonBlock height="0.75rem" width="15%" />
        <SkeletonBlock height="0.75rem" width="20%" />
        <SkeletonBlock height="0.75rem" width="15%" />
        <SkeletonBlock height="0.75rem" width="15%" />
        <SkeletonBlock height="0.75rem" width="18%" />
      </div>
      <!-- 6 строк данных -->
      <div v-for="n in 6" :key="n" class="flex gap-3 px-3 py-2.5 border-b border-gray-50">
        <SkeletonBlock height="2rem" width="15%" rounded="rounded-lg" />
        <SkeletonBlock height="2rem" width="20%" rounded="rounded-lg" />
        <SkeletonBlock height="2rem" width="15%" rounded="rounded-lg" />
        <SkeletonBlock height="2rem" width="15%" rounded="rounded-lg" />
        <SkeletonBlock height="1.5rem" width="18%" rounded="rounded-full" />
      </div>
    </div>
    <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
    <div v-else class="bg-white border border-gray-200 rounded-[14px] shadow-sm overflow-x-auto">
      <table class="w-full text-[13px] border-collapse">
        <thead>
          <tr>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">АЗС</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Уведомление</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Дедлайн</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Сдано</th>
            <th class="text-left text-[11.5px] uppercase tracking-[0.4px] text-gray-400 font-bold px-3 py-2.5 border-b border-gray-100">Статус</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in displayItems" :key="item.id" class="hover:bg-gray-50">
            <td class="px-3 py-2.5 border-b border-gray-50">
              <b class="block">{{ item.azsTitle || `АЗС ${item.azsId}` }}</b>
              <span class="text-[12px] text-gray-400">ID {{ item.azsId }}</span>
            </td>
            <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.scheduledAt) }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.deadlineAt) }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50 tabular-nums">{{ fmtTime(item.updatedAt) }}</td>
            <td class="px-3 py-2.5 border-b border-gray-50">
              <span :class="['inline-flex items-center gap-1.5 text-[12px] font-bold px-2.5 py-1 rounded-full', STATUS_COLOR[item.status] || 'text-gray-500 bg-gray-100']">
                <span class="w-1.5 h-1.5 rounded-full bg-current opacity-90"/>
                {{ STATUS_LABEL[item.status] || item.status }}
              </span>
            </td>
          </tr>
          <tr v-if="!displayItems.length">
            <td colspan="5" class="text-center py-8 text-gray-400">Нет данных за выбранный период</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
