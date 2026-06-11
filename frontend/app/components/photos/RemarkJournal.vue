<script setup lang="ts">
/**
 * RemarkJournal — вкладка «Журнал» фотоленты (спека §4.4).
 * Виды: «Лента» (хронология) / «По АЗС» (<details>-группы).
 * Фильтры: период + мультиселект АЗС.
 * Пагинация keyset «Показать ещё».
 * Retry для записей со статусом failed.
 */

type AzsOption = {
  value: string
  label: string
}

type PhotoRef = {
  remarkId: number
  reportId: number
  photoCode: string
}

type RemarkItem = {
  id: number
  createdAt: string | null
  azsId: string
  azsTitle: string | null
  recipientRole: 'manager' | 'admin'
  recipientName: string | null
  message: string
  senderName: string | null
  deliveryStatus: 'sent' | 'failed'
  deliveryError: string | null
  photos: PhotoRef[]
}

const props = defineProps<{
  azsOptions: AzsOption[]
}>()

const emit = defineEmits<{
  (e: 'open-photo', payload: { azsId: string; dateFrom: string; dateTo: string; reportId: number; photoCode: string }): void
  (e: 'loaded', count: number): void
}>()

const apiStore = useApiStore()
const toast = useAppToast()

// ── Вид ──────────────────────────────────────────────────────────────────────
type JournalView = 'timeline' | 'by-azs'
const activeView = ref<JournalView>('timeline')

// ── Фильтры ──────────────────────────────────────────────────────────────────
type PeriodKey = 'today' | 'yesterday' | 'week' | 'custom'
const PERIODS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: 'Неделя' },
  { key: 'custom', label: 'Диапазон' },
]
const period = ref<PeriodKey>('week')
const customFrom = ref('')
const customTo = ref('')
const selectedAzsIds = ref<string[]>([])
const azsSearch = ref('')

const filteredAzsOptions = computed(() => {
  const q = azsSearch.value.trim().toLowerCase()
  if (!q) return props.azsOptions
  return props.azsOptions.filter(o =>
    o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  )
})

const toggleAzs = (val: string) => {
  const idx = selectedAzsIds.value.indexOf(val)
  if (idx === -1) selectedAzsIds.value = [...selectedAzsIds.value, val]
  else selectedAzsIds.value = selectedAzsIds.value.filter(v => v !== val)
}

const to2 = (n: number) => String(n).padStart(2, '0')

const getDateRange = (): { dateFrom: string; dateTo: string } => {
  const now = new Date()
  const todayStr = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`
  if (period.value === 'today') return { dateFrom: todayStr, dateTo: todayStr }
  if (period.value === 'yesterday') {
    const y = new Date(now)
    y.setUTCDate(y.getUTCDate() - 1)
    const ys = `${y.getUTCFullYear()}-${to2(y.getUTCMonth() + 1)}-${to2(y.getUTCDate())}`
    return { dateFrom: ys, dateTo: ys }
  }
  if (period.value === 'week') {
    const w = new Date(now)
    w.setUTCDate(w.getUTCDate() - 6)
    const ws = `${w.getUTCFullYear()}-${to2(w.getUTCMonth() + 1)}-${to2(w.getUTCDate())}`
    return { dateFrom: ws, dateTo: todayStr }
  }
  return { dateFrom: customFrom.value, dateTo: customTo.value }
}

// ── Загрузка ─────────────────────────────────────────────────────────────────
const LIMIT = 30
const items = ref<RemarkItem[]>([])
const nextCursor = ref<string | null>(null)
const isLoading = ref(false)
const isLoadingMore = ref(false)
const loadError = ref('')

const buildParams = (cursor?: string) => {
  const range = getDateRange()
  const params: Parameters<typeof apiStore.getPhotoRemarks>[0] = { limit: LIMIT }
  if (range.dateFrom) params.dateFrom = range.dateFrom
  if (range.dateTo) params.dateTo = range.dateTo
  if (selectedAzsIds.value.length > 0) params.azsIds = selectedAzsIds.value
  if (cursor) params.cursor = cursor
  return params
}

const load = async () => {
  if (period.value === 'custom' && (!customFrom.value || !customTo.value)) return
  isLoading.value = true
  loadError.value = ''
  items.value = []
  nextCursor.value = null
  try {
    const resp = await apiStore.getPhotoRemarks(buildParams())
    items.value = resp.items
    nextCursor.value = resp.nextCursor
    emit('loaded', resp.items.length)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Не удалось загрузить журнал'
  } finally {
    isLoading.value = false
  }
}

const loadMore = async () => {
  if (!nextCursor.value || isLoadingMore.value) return
  isLoadingMore.value = true
  try {
    const resp = await apiStore.getPhotoRemarks(buildParams(nextCursor.value))
    items.value = [...items.value, ...resp.items]
    nextCursor.value = resp.nextCursor
  } catch {
    toast.error('Не удалось загрузить следующую страницу. Попробуйте ещё раз.')
  } finally {
    isLoadingMore.value = false
  }
}

// Перезагрузка при смене фильтров (debounced)
let filterTimer: ReturnType<typeof setTimeout> | null = null
const scheduleLoad = () => {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => void load(), 120)
}

watch([period, selectedAzsIds, customFrom, customTo], scheduleLoad, { deep: false })

onMounted(() => void load())

// ── Blob-превью для миниатюр ──────────────────────────────────────────────
const previewUrls = ref(new Map<string, string>())
const previewsLoading = ref(new Set<string>())

const thumbKey = (ph: PhotoRef) => `${ph.reportId}:${ph.photoCode}`

const loadThumb = async (ph: PhotoRef) => {
  const key = thumbKey(ph)
  if (previewUrls.value.has(key) || previewsLoading.value.has(key)) return
  previewsLoading.value = new Set([...previewsLoading.value, key])
  try {
    const url = await apiStore.getPhotoPreviewObjectUrl(ph.reportId, ph.photoCode)
    const next = new Map(previewUrls.value)
    next.set(key, url)
    previewUrls.value = next
  } catch {
    // silent — показывается placeholder
  } finally {
    const next = new Set(previewsLoading.value)
    next.delete(key)
    previewsLoading.value = next
  }
}

// Lazy load thumbs via IntersectionObserver
const cardRefs = ref(new Map<number, HTMLElement>())
let thumbObserver: IntersectionObserver | null = null

const setCardRef = (id: number, el: HTMLElement | null) => {
  if (el) {
    cardRefs.value.set(id, el)
    thumbObserver?.observe(el)
  } else {
    cardRefs.value.delete(id)
  }
}

onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') return
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      const id = Number((entry.target as HTMLElement).dataset.remarkId)
      const item = items.value.find(i => i.id === id)
      if (item) {
        for (const ph of item.photos.slice(0, 4)) void loadThumb(ph)
      }
    }
  }, { rootMargin: '100px' })
})

onBeforeUnmount(() => {
  thumbObserver?.disconnect()
  for (const url of previewUrls.value.values()) URL.revokeObjectURL(url)
})

// ── Retry failed remark ───────────────────────────────────────────────────
const retryingIds = ref(new Set<number>())

const handleRetry = async (item: RemarkItem) => {
  if (retryingIds.value.has(item.id)) return
  retryingIds.value = new Set([...retryingIds.value, item.id])
  try {
    const updated = await apiStore.retryPhotoRemark(item.id)
    const idx = items.value.findIndex(i => i.id === item.id)
    if (idx !== -1) {
      items.value = [
        ...items.value.slice(0, idx),
        { ...items.value[idx], deliveryStatus: updated.deliveryStatus, deliveryError: updated.deliveryError ?? null },
        ...items.value.slice(idx + 1)
      ]
    }
    if (updated.deliveryStatus === 'sent') {
      toast.success('Повторная отправка выполнена')
    } else {
      toast.error(`Повторная отправка не удалась: ${updated.deliveryError || 'неизвестная ошибка'}`)
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Не удалось повторить отправку')
  } finally {
    const next = new Set(retryingIds.value)
    next.delete(item.id)
    retryingIds.value = next
  }
}

// ── Навигация: миниатюра → лента ─────────────────────────────────────────
const handleThumbClick = (item: RemarkItem, ph: PhotoRef) => {
  const range = (() => {
    if (!item.createdAt) return { dateFrom: '', dateTo: '' }
    const d = new Date(item.createdAt)
    const s = `${d.getUTCFullYear()}-${to2(d.getUTCMonth() + 1)}-${to2(d.getUTCDate())}`
    return { dateFrom: s, dateTo: s }
  })()
  emit('open-photo', {
    azsId: item.azsId,
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    reportId: ph.reportId,
    photoCode: ph.photoCode
  })
}

// ── Форматирование ────────────────────────────────────────────────────────
const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${to2(d.getDate())}.${to2(d.getMonth() + 1)}.${d.getFullYear()} ${to2(d.getHours())}:${to2(d.getMinutes())}`
  } catch { return '—' }
}

const ROLE_LABELS: Record<string, string> = {
  manager: 'Управляющий',
  admin: 'Администратор АЗС'
}

// ── Группировка По АЗС ────────────────────────────────────────────────────
type AzsGroup = { azsId: string; azsTitle: string; items: RemarkItem[] }

const grouped = computed<AzsGroup[]>(() => {
  const map = new Map<string, AzsGroup>()
  for (const item of items.value) {
    if (!map.has(item.azsId)) {
      map.set(item.azsId, {
        azsId: item.azsId,
        azsTitle: item.azsTitle || `АЗС ${item.azsId}`,
        items: []
      })
    }
    map.get(item.azsId)!.items.push(item)
  }
  return [...map.values()]
})

const GRAD = 'linear-gradient(135deg,#6a8caf,#34506b)'
</script>

<template>
  <div>
    <!-- Шапка журнала -->
    <div class="mb-4 flex items-center justify-between flex-wrap gap-2">
      <div>
        <h2 class="text-base font-semibold text-gray-800">Журнал замечаний</h2>
        <p class="text-xs text-gray-400 mt-0.5">Видно всем проверяющим и администраторам</p>
      </div>

      <!-- Переключатель вида: Лента / По АЗС -->
      <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm">
        <button
          :class="[
            'px-3 py-2 font-medium transition-colors border-r border-gray-200',
            activeView === 'timeline' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
          ]"
          @click="activeView = 'timeline'"
        >
          Лента
        </button>
        <button
          :class="[
            'px-3 py-2 font-medium transition-colors',
            activeView === 'by-azs' ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
          ]"
          @click="activeView = 'by-azs'"
        >
          По АЗС
        </button>
      </div>
    </div>

    <!-- Панель фильтров -->
    <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 mb-4 space-y-3">

      <!-- Период -->
      <div>
        <p class="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1.5">Период</p>
        <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm flex-wrap">
          <button
            v-for="p in PERIODS"
            :key="p.key"
            :class="[
              'px-3 py-2 font-medium transition-colors border-l border-gray-200 first:border-l-0',
              period === p.key ? 'bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-50'
            ]"
            @click="period = p.key"
          >
            {{ p.label }}
          </button>
        </div>
        <div v-if="period === 'custom'" class="flex gap-2 items-center mt-2">
          <input
            v-model="customFrom"
            type="date"
            class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
          >
          <span class="text-gray-400">—</span>
          <input
            v-model="customTo"
            type="date"
            class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
          >
        </div>
      </div>

      <!-- АЗС мультиселект -->
      <div>
        <div class="flex items-center justify-between mb-1">
          <p class="text-xs text-gray-500 font-medium uppercase tracking-wide">АЗС</p>
          <button
            v-if="selectedAzsIds.length > 0"
            class="text-xs text-gray-400 hover:text-gray-600"
            @click="selectedAzsIds = []"
          >
            Снять все
          </button>
        </div>
        <div class="relative mb-1.5">
          <input
            v-model="azsSearch"
            type="text"
            placeholder="Поиск АЗС…"
            class="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
          >
          <button
            v-if="azsSearch"
            class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
            @click="azsSearch = ''"
          >
            ✕
          </button>
        </div>
        <div class="max-h-36 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
          <label
            v-for="opt in filteredAzsOptions"
            :key="opt.value"
            class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-gray-50"
            :class="{ 'bg-blue-50': selectedAzsIds.includes(opt.value) }"
          >
            <input
              type="checkbox"
              :value="opt.value"
              :checked="selectedAzsIds.includes(opt.value)"
              class="rounded border-gray-300 text-blue-600"
              @change="toggleAzs(opt.value)"
            >
            <span :class="selectedAzsIds.includes(opt.value) ? 'text-blue-800 font-medium' : 'text-gray-700'">
              {{ opt.label }}
            </span>
          </label>
          <div v-if="azsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">Нет доступных АЗС</div>
          <div v-else-if="filteredAzsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">Ничего не найдено</div>
        </div>
        <p class="text-xs text-gray-400 mt-1">
          <span v-if="selectedAzsIds.length > 0" class="text-blue-600">Выбрано: {{ selectedAzsIds.length }}</span>
          <span v-else>Все АЗС</span>
        </p>
      </div>
    </div>

    <!-- Скелетоны загрузки -->
    <template v-if="isLoading">
      <div class="space-y-3">
        <div
          v-for="n in 4"
          :key="`skel-${n}`"
          class="bg-white rounded-[14px] border border-gray-200 shadow-sm p-4"
        >
          <SkeletonBlock height="1rem" width="60%" rounded="rounded" class="mb-2" />
          <SkeletonBlock height="0.875rem" width="40%" rounded="rounded" class="mb-3" />
          <div class="flex gap-2">
            <SkeletonBlock v-for="k in 3" :key="k" height="3.5rem" width="4.5rem" rounded="rounded-lg" />
          </div>
        </div>
      </div>
    </template>

    <!-- Ошибка загрузки -->
    <template v-else-if="loadError">
      <div class="bg-white rounded-[14px] border border-gray-200 shadow-sm p-4 flex flex-col gap-2">
        <p class="text-sm text-red-600">{{ loadError }}</p>
        <button
          class="self-start px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium"
          @click="load"
        >
          ↻ Повторить
        </button>
      </div>
    </template>

    <!-- Пустое состояние -->
    <template v-else-if="items.length === 0">
      <div class="bg-white rounded-[14px] border border-gray-200 shadow-sm p-12 text-center">
        <p class="text-gray-400 text-sm">Замечаний пока нет</p>
        <p class="text-gray-300 text-xs mt-1">Попробуйте изменить период или выбрать другие АЗС</p>
      </div>
    </template>

    <!-- Лента (timeline) -->
    <template v-else-if="activeView === 'timeline'">
      <div class="space-y-3">
        <div
          v-for="item in items"
          :key="item.id"
          :ref="(el) => setCardRef(item.id, el as HTMLElement | null)"
          :data-remark-id="item.id"
          class="bg-white rounded-[14px] border border-gray-200 shadow-sm p-4"
        >
          <!-- Мета-строка -->
          <div class="flex items-start justify-between gap-2 mb-2 flex-wrap">
            <div class="text-xs text-gray-400 tabular-nums">{{ fmtDateTime(item.createdAt) }}</div>
            <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
              {{ item.azsTitle || `АЗС ${item.azsId}` }}
            </span>
          </div>

          <!-- Получатель -->
          <div class="text-sm text-gray-700 mb-1">
            <span class="font-medium">{{ item.recipientName || '—' }}</span>
            <span class="text-gray-400 text-xs ml-1">({{ ROLE_LABELS[item.recipientRole] || item.recipientRole }})</span>
          </div>

          <!-- Текст замечания -->
          <p class="text-sm text-gray-800 mb-2 leading-snug">«{{ item.message }}»</p>

          <!-- Миниатюры фото (до 4) -->
          <div v-if="item.photos.length > 0" class="flex gap-2 flex-wrap mb-2">
            <button
              v-for="ph in item.photos.slice(0, 4)"
              :key="thumbKey(ph)"
              class="relative w-16 h-12 rounded-lg overflow-hidden border border-black/10 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-blue-400"
              :style="`background:${GRAD}`"
              :title="`${ph.photoCode} — открыть в ленте`"
              @click="handleThumbClick(item, ph)"
            >
              <img
                v-if="previewUrls.get(thumbKey(ph))"
                :src="previewUrls.get(thumbKey(ph))!"
                class="absolute inset-0 w-full h-full object-cover"
                :alt="ph.photoCode"
              >
              <div
                v-else
                class="absolute inset-0 flex items-center justify-center text-white/50 text-[10px]"
              >
                {{ ph.photoCode }}
              </div>
            </button>
            <span v-if="item.photos.length > 4" class="text-xs text-gray-400 self-center">
              +{{ item.photos.length - 4 }}
            </span>
          </div>

          <!-- Отправитель -->
          <p class="text-xs text-gray-400">отправил {{ item.senderName || '—' }}</p>

          <!-- Статус: не доставлено -->
          <div v-if="item.deliveryStatus === 'failed'" class="mt-2 flex items-center gap-2 flex-wrap">
            <span class="text-xs font-semibold text-red-600">Не доставлено</span>
            <span v-if="item.deliveryError" class="text-xs text-red-400 truncate max-w-[200px]" :title="item.deliveryError">
              {{ item.deliveryError }}
            </span>
            <button
              class="text-xs px-3 py-1 rounded-full border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
              :disabled="retryingIds.has(item.id)"
              @click="handleRetry(item)"
            >
              {{ retryingIds.has(item.id) ? 'Повтор…' : '↻ Повторить' }}
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- По АЗС -->
    <template v-else>
      <div class="space-y-3">
        <details
          v-for="group in grouped"
          :key="group.azsId"
          open
          class="bg-white rounded-[14px] border border-gray-200 shadow-sm"
        >
          <summary class="flex items-center justify-between px-4 py-3 cursor-pointer list-none select-none">
            <span class="font-semibold text-sm text-gray-800">{{ group.azsTitle }}</span>
            <span class="text-xs text-gray-400">{{ group.items.length }} замечани{{ group.items.length === 1 ? 'е' : group.items.length < 5 ? 'я' : 'й' }}</span>
          </summary>

          <div class="px-4 pb-4 space-y-3 border-t border-gray-100 pt-3">
            <div
              v-for="item in group.items"
              :key="item.id"
              :ref="(el) => setCardRef(item.id, el as HTMLElement | null)"
              :data-remark-id="item.id"
              class="border border-gray-100 rounded-xl p-3"
            >
              <div class="flex items-start justify-between gap-2 mb-1.5 flex-wrap">
                <div class="text-xs text-gray-400 tabular-nums">{{ fmtDateTime(item.createdAt) }}</div>
              </div>
              <div class="text-sm text-gray-700 mb-1">
                <span class="font-medium">{{ item.recipientName || '—' }}</span>
                <span class="text-gray-400 text-xs ml-1">({{ ROLE_LABELS[item.recipientRole] || item.recipientRole }})</span>
              </div>
              <p class="text-sm text-gray-800 mb-2 leading-snug">«{{ item.message }}»</p>
              <div v-if="item.photos.length > 0" class="flex gap-2 flex-wrap mb-1.5">
                <button
                  v-for="ph in item.photos.slice(0, 4)"
                  :key="thumbKey(ph)"
                  class="relative w-16 h-12 rounded-lg overflow-hidden border border-black/10 flex-shrink-0"
                  :style="`background:${GRAD}`"
                  :title="`${ph.photoCode} — открыть в ленте`"
                  @click="handleThumbClick(item, ph)"
                >
                  <img
                    v-if="previewUrls.get(thumbKey(ph))"
                    :src="previewUrls.get(thumbKey(ph))!"
                    class="absolute inset-0 w-full h-full object-cover"
                    :alt="ph.photoCode"
                  >
                  <div v-else class="absolute inset-0 flex items-center justify-center text-white/50 text-[10px]">
                    {{ ph.photoCode }}
                  </div>
                </button>
                <span v-if="item.photos.length > 4" class="text-xs text-gray-400 self-center">+{{ item.photos.length - 4 }}</span>
              </div>
              <p class="text-xs text-gray-400">отправил {{ item.senderName || '—' }}</p>
              <div v-if="item.deliveryStatus === 'failed'" class="mt-1.5 flex items-center gap-2 flex-wrap">
                <span class="text-xs font-semibold text-red-600">Не доставлено</span>
                <button
                  class="text-xs px-3 py-1 rounded-full border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 transition-colors"
                  :disabled="retryingIds.has(item.id)"
                  @click="handleRetry(item)"
                >
                  {{ retryingIds.has(item.id) ? 'Повтор…' : '↻ Повторить' }}
                </button>
              </div>
            </div>
          </div>
        </details>
      </div>
    </template>

    <!-- Pagination -->
    <div v-if="nextCursor && !isLoading" class="mt-4 flex flex-col items-center gap-3">
      <template v-if="isLoadingMore">
        <div class="space-y-3 w-full">
          <SkeletonBlock v-for="n in 2" :key="n" height="5rem" rounded="rounded-[14px]" />
        </div>
      </template>
      <button
        v-else
        class="px-6 py-2.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium shadow-sm"
        @click="loadMore"
      >
        Показать ещё
      </button>
    </div>

    <!-- Конец журнала -->
    <p v-else-if="!isLoading && !nextCursor && items.length > 0" class="text-center text-xs text-gray-400 mt-6">
      Все записи загружены · {{ items.length }}{{ items.length >= LIMIT ? '+' : '' }} замечани{{ items.length === 1 ? 'е' : items.length < 5 ? 'я' : 'й' }}
    </p>
  </div>
</template>
