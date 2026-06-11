<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'
import type { PhotoFiltersValue } from '~/components/photos/PhotoFilters.vue'
import type { RemarkRecipient } from '~/components/photos/RemarkDraftPanel.vue'

const PAGE_TITLE = 'Фотолента АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('PhotoFeedPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const toast = useAppToast()

let $b24: null | B24Frame = null

// ── Доступ ────────────────────────────────────────────────────────────────
const hasAccess = ref(false)
const accessError = ref('')
const initError = ref('')

// ── Фильтры ──────────────────────────────────────────────────────────────
const FILTERS_KEY = 'photoFeed.filters'

const DEFAULT_FILTERS: PhotoFiltersValue = {
  period: 'today',
  customDateFrom: '',
  customDateTo: '',
  azsIds: [],
  categoryСodes: [],
  remarks: 'all',
  groupByAzs: false
}

const loadPersistedFilters = (): PhotoFiltersValue => {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (!raw) return { ...DEFAULT_FILTERS }
    const parsed = JSON.parse(raw) as Partial<PhotoFiltersValue>
    return {
      ...DEFAULT_FILTERS,
      ...parsed,
    }
  } catch {
    return { ...DEFAULT_FILTERS }
  }
}

const persistFilters = (filters: PhotoFiltersValue) => {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters))
  } catch {
    // localStorage может быть недоступен в iframe — тихая деградация
  }
}

const filters = ref<PhotoFiltersValue>(loadPersistedFilters())

watch(filters, (val) => persistFilters(val), { deep: true })

const resetFilters = () => {
  filters.value = { ...DEFAULT_FILTERS }
}

// ── АЗС-опции для PhotoFilters ────────────────────────────────────────────
type AzsOption = {
  value: string
  label: string
}
const azsOptions = ref<AzsOption[]>([])

const loadAzsOptions = async () => {
  try {
    const resp = await apiStore.getAzsOptions({ limit: 500 })
    azsOptions.value = resp.items.map(item => ({
      value: String(item.id || '').trim(),
      label: String(item.title || `АЗС ${item.id}`).trim()
    }))
  } catch {
    // АЗС-фильтр деградирует к пустому списку — лента продолжает работать
  }
}

// ── Загрузка ленты (cursor pagination) ───────────────────────────────────
type PhotoFeedItem = {
  reportId: number
  azsId: string
  azsTitle?: string | null
  photoCode: string
  exifAt: string | null
  uploadedAt: string | null
  remark: { dt: string; recipientName: string; message: string; senderName: string } | null
}

const items = ref<PhotoFeedItem[]>([])
const nextCursor = ref<string | null>(null)
const loadError = ref('')
const isLoading = ref(false)
const isLoadingMore = ref(false)
const LIMIT = 40

const getDateRange = (): { from: string; to: string } => {
  const now = new Date()
  const to2 = (n: number) => String(n).padStart(2, '0')
  const todayStr = `${now.getUTCFullYear()}-${to2(now.getUTCMonth() + 1)}-${to2(now.getUTCDate())}`

  if (filters.value.period === 'today') return { from: todayStr, to: todayStr }
  if (filters.value.period === 'yesterday') {
    const y = new Date(now)
    y.setUTCDate(y.getUTCDate() - 1)
    const ys = `${y.getUTCFullYear()}-${to2(y.getUTCMonth() + 1)}-${to2(y.getUTCDate())}`
    return { from: ys, to: ys }
  }
  if (filters.value.period === 'week') {
    const w = new Date(now)
    w.setUTCDate(w.getUTCDate() - 6)
    const ws = `${w.getUTCFullYear()}-${to2(w.getUTCMonth() + 1)}-${to2(w.getUTCDate())}`
    return { from: ws, to: todayStr }
  }
  return { from: filters.value.customDateFrom, to: filters.value.customDateTo }
}

const buildFeedParams = (cursor?: string) => {
  const range = getDateRange()
  const params: Parameters<typeof apiStore.getPhotoFeed>[0] = {
    limit: LIMIT,
    remarks: filters.value.remarks
  }
  if (range.from) params.dateFrom = range.from
  if (range.to) params.dateTo = range.to
  if (filters.value.azsIds.length > 0) params.azsId = filters.value.azsIds
  if (filters.value.categoryСodes.length > 0) params.photoCode = filters.value.categoryСodes
  if (cursor) params.cursor = cursor
  return params
}

const loadFeed = async () => {
  isLoading.value = true
  loadError.value = ''
  items.value = []
  nextCursor.value = null
  try {
    const resp = await apiStore.getPhotoFeed(buildFeedParams())
    items.value = resp.items
    nextCursor.value = resp.nextCursor
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'Не удалось загрузить фотоленту'
  } finally {
    isLoading.value = false
  }
}

const loadMore = async () => {
  if (!nextCursor.value || isLoadingMore.value) return
  isLoadingMore.value = true
  try {
    const resp = await apiStore.getPhotoFeed(buildFeedParams(nextCursor.value))
    items.value = [...items.value, ...resp.items]
    nextCursor.value = resp.nextCursor
  } catch {
    toast.error('Не удалось загрузить следующую страницу. Попробуйте ещё раз.')
  } finally {
    isLoadingMore.value = false
  }
}

// ── Sentinel IntersectionObserver для автоподгрузки ───────────────────────
const sentinelRef = ref<HTMLElement | null>(null)
let sentinelObserver: IntersectionObserver | null = null

const setupSentinel = () => {
  if (typeof IntersectionObserver === 'undefined' || !sentinelRef.value) return
  sentinelObserver?.disconnect()
  sentinelObserver = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && nextCursor.value && !isLoadingMore.value) {
        void loadMore()
      }
    },
    { rootMargin: '200px' }
  )
  sentinelObserver.observe(sentinelRef.value)
}

// ── Черновик замечания (С1/С2/С3) ────────────────────────────────────────
type MarkEntry = { reportId: number; photoCode: string; azsId: string; azsTitle: string }
const marks = ref(new Map<string, MarkEntry>())
const activeAzsId = ref<string>('')

const markedKeys = computed(() => new Set(marks.value.keys()))

const draftCount = computed(() => marks.value.size)

const draftAzsTitle = computed(() => {
  if (!activeAzsId.value) return ''
  for (const entry of marks.value.values()) {
    if (entry.azsId === activeAzsId.value) return entry.azsTitle || `АЗС ${entry.azsId}`
  }
  return `АЗС ${activeAzsId.value}`
})

// ── Получатели (загружаются при первой отметке АЗС) ───────────────────────
const draftManager = ref<RemarkRecipient>(null)
const draftAdmin = ref<RemarkRecipient>(null)
const recipientsLoading = ref(false)

const loadRecipients = async (azsId: string) => {
  recipientsLoading.value = true
  try {
    const resp = await apiStore.getPhotoRecipients(azsId)
    draftManager.value = resp.manager
    draftAdmin.value = resp.admin
  } catch {
    draftManager.value = null
    draftAdmin.value = null
  } finally {
    recipientsLoading.value = false
  }
}

// ── Шаблоны из настроек (с фоллбеком) ────────────────────────────────────
const DEFAULT_TEMPLATES = [
  'Переделайте выкладку промо-товара',
  'Перегрузите правый монитор — старая реклама'
]

const settingsTemplates = ref<string[] | null>(null)

const remarkTemplates = computed<string[]>(() => {
  if (settingsTemplates.value && settingsTemplates.value.length > 0) return settingsTemplates.value
  return DEFAULT_TEMPLATES
})

const loadRemarkTemplates = async () => {
  try {
    const resp = await apiStore.getSettings()
    const raw = (resp.settings as Record<string, unknown>)?.photoFeed
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const feed = raw as Record<string, unknown>
      if (Array.isArray(feed.remarkTemplates) && feed.remarkTemplates.length > 0) {
        settingsTemplates.value = feed.remarkTemplates.map(String)
      }
    }
  } catch {
    // фоллбек на DEFAULT_TEMPLATES — уже задан
  }
}

// ── Отправка (С1/С2) ─────────────────────────────────────────────────────
const isSending = ref(false)

const handleSend = async ({ recipientRole, message }: { recipientRole: 'manager' | 'admin'; message: string }) => {
  if (isSending.value || marks.value.size === 0) return
  isSending.value = true
  try {
    const photos = [...marks.value.values()].map(m => ({ reportId: m.reportId, photoCode: m.photoCode }))
    const result = await apiStore.sendPhotoRemark({
      azsId: activeAzsId.value,
      recipientRole,
      message,
      photos
    })
    const rec = result.item
    // Локально проставить remark на отмеченные фото (бейджи сразу)
    for (const [, entry] of marks.value.entries()) {
      const idx = items.value.findIndex(i => i.reportId === entry.reportId && i.photoCode === entry.photoCode)
      if (idx !== -1) {
        items.value[idx] = {
          ...items.value[idx],
          remark: {
            dt: rec.createdAt,
            recipientName: rec.recipientName,
            message: rec.message,
            senderName: rec.senderName
          }
        }
      }
    }
    const n = marks.value.size
    toast.success(`Отправлено: ${rec.recipientName} (АЗС ${rec.azsId}) — ${n} фото`)
    marks.value = new Map()
    activeAzsId.value = ''
    draftManager.value = null
    draftAdmin.value = null
  } catch (e: unknown) {
    const errData = (e as { data?: { errorCode?: string; message?: string } })?.data
    if (errData?.errorCode === 'RECIPIENT_NOT_SET') {
      toast.error('У АЗС не указан получатель — выберите администратора')
    } else {
      toast.error(errData?.message || (e instanceof Error ? e.message : 'Не удалось отправить замечание'))
    }
    // Черновик НЕ теряем при ошибке
  } finally {
    isSending.value = false
  }
}

const handleDraftClear = () => {
  marks.value = new Map()
  activeAzsId.value = ''
  draftManager.value = null
  draftAdmin.value = null
}

// ── Inline-конфликт АЗС (С3) ─────────────────────────────────────────────
const conflictItem = ref<PhotoFeedItem | null>(null)
const conflictMessage = computed(() => {
  if (!conflictItem.value) return ''
  const n = marks.value.size
  return `В замечании уже ${n} фото АЗС ${draftAzsTitle.value}`
})

const resolveConflictSendCurrentThenMark = () => {
  // Закрываем конфликт — пользователь возвращается в панель для отправки текущего
  conflictItem.value = null
}

const resolveConflictClearAndMark = () => {
  const item = conflictItem.value
  if (!item) return
  conflictItem.value = null
  marks.value = new Map()
  activeAzsId.value = ''
  draftManager.value = null
  draftAdmin.value = null
  // Отмечаем новое фото
  doMark(item)
}

const doMark = (item: PhotoFeedItem) => {
  const key = `${item.reportId}:${item.photoCode}`
  if (marks.value.has(key)) {
    // Снять отметку
    const next = new Map(marks.value)
    next.delete(key)
    marks.value = next
    if (marks.value.size === 0) activeAzsId.value = ''
    return
  }
  // Добавить отметку
  const next = new Map(marks.value)
  next.set(key, {
    reportId: item.reportId,
    photoCode: item.photoCode,
    azsId: item.azsId,
    azsTitle: item.azsTitle || `АЗС ${item.azsId}`
  })
  marks.value = next
  if (!activeAzsId.value) {
    activeAzsId.value = item.azsId
    void loadRecipients(item.azsId)
  }
}

// ── Лайтбокс ─────────────────────────────────────────────────────────────
const lightboxIndex = ref(-1)
const lightboxOpen = computed(() => lightboxIndex.value >= 0)

// ── Обработчики событий сетки ─────────────────────────────────────────────
const handleOpen = (index: number) => {
  lightboxIndex.value = index
}

const handleToggleMark = (item: PhotoFeedItem) => {
  const key = `${item.reportId}:${item.photoCode}`
  const isAlreadyMarked = marks.value.has(key)

  if (!isAlreadyMarked && activeAzsId.value && item.azsId !== activeAzsId.value) {
    // С3: конфликт АЗС — показать inline-промпт
    conflictItem.value = item
    return
  }

  doMark(item)
}

const handleRemarkInfo = (item: PhotoFeedItem) => {
  if (!item.remark) return
  const r = item.remark
  const dt = r.dt
    ? new Date(r.dt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—'
  toast.info(`${dt} → ${r.recipientName}: «${r.message}» — отправил ${r.senderName}`)
}

const handleLightboxNeedMore = () => {
  void loadMore()
}

const handleLightboxClose = () => {
  lightboxIndex.value = -1
}

const handleLightboxToggleMark = (item: PhotoFeedItem) => {
  handleToggleMark(item)
}

onMounted(async () => {
  try {
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)

    // Проверка ролей (паттерн reports.client.vue)
    const roleResp = await apiStore.getMyRole()
    hasAccess.value = Boolean(roleResp.capabilities?.reviewer || roleResp.capabilities?.settings)
    if (!hasAccess.value) {
      accessError.value = 'Фотолента доступна только проверяющим и администраторам. Обратитесь к администратору портала.'
      return
    }

    await Promise.all([
      loadAzsOptions(),
      loadFeed(),
      loadRemarkTemplates()
    ])

    nextTick(() => setupSentinel())
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Ошибка инициализации'
    if (msg.includes('Unable to initialize Bitrix24Frame')) {
      processErrorGlobal(error)
      return
    }
    initError.value = msg
  }
})

onBeforeUnmount(() => {
  sentinelObserver?.disconnect()
})

// Перезагружать при смене фильтров (debounced — кастомный период требует обоих дат)
let filterTimer: ReturnType<typeof setTimeout> | null = null
watch(filters, () => {
  if (filters.value.period === 'custom') {
    if (!filters.value.customDateFrom || !filters.value.customDateTo) return
  }
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    void loadFeed()
  }, 120)
}, { deep: true })

const goBack = () => {
  if (window.history.length > 1) {
    window.history.back()
  } else {
    void navigateTo('/')
  }
}
</script>

<template>
  <div class="w-full bg-[#eef1f4] min-h-screen">

    <!-- Ошибка доступа -->
    <div v-if="accessError" class="max-w-[1280px] mx-auto px-4 py-6">
      <B24Alert color="air-primary-alert" title="Нет доступа" :description="accessError" />
    </div>

    <!-- Ошибка инициализации -->
    <div v-else-if="initError" class="max-w-[1280px] mx-auto px-4 py-6 flex flex-col gap-2">
      <B24Alert color="air-primary-alert" title="Ошибка инициализации" :description="initError" />
      <div>
        <button
          class="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium"
          @click="initError = ''"
        >
          ↻ Повторить
        </button>
      </div>
    </div>

    <template v-else-if="hasAccess">
      <div class="max-w-[1280px] mx-auto px-4 py-6">

        <!-- Шапка (паттерн соседних страниц) -->
        <header class="mb-6">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="flex items-start gap-3">
              <button
                aria-label="Назад"
                class="inline-flex items-center justify-center w-9 h-9 rounded-full text-gray-600 hover:bg-gray-100 transition-colors flex-shrink-0"
                @click="goBack"
              >
                ←
              </button>
              <div>
                <h1 class="text-2xl font-semibold">Фотолента АЗС</h1>
                <p class="text-sm text-gray-500 mt-1">Просмотр и фильтрация фотографий по всем АЗС</p>
              </div>
            </div>

            <div class="flex items-center gap-2 flex-wrap">
              <button
                class="px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium disabled:opacity-50"
                :disabled="isLoading"
                @click="loadFeed"
              >
                {{ isLoading ? 'Обновление…' : '↻ Обновить' }}
              </button>
              <button
                class="px-4 py-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-gray-600 text-sm font-medium"
                @click="resetFilters"
              >
                Сбросить фильтры
              </button>
            </div>
          </div>
        </header>

        <!-- Двухколоночный макет: фильтры слева + лента справа -->
        <div class="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">

          <!-- Панель фильтров -->
          <aside class="lg:sticky lg:top-4">
            <PhotoFilters
              v-model="filters"
              :azs-options="azsOptions"
            />
          </aside>

          <!-- Основной контент -->
          <main>

            <!-- Ошибка загрузки с «Повторить» (S2-03) -->
            <div v-if="loadError" class="mb-4 flex flex-col gap-2">
              <B24Alert color="air-primary-alert" title="Ошибка загрузки" :description="loadError" />
              <div>
                <button
                  class="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium disabled:opacity-50"
                  :disabled="isLoading"
                  @click="loadFeed"
                >
                  {{ isLoading ? 'Загрузка…' : '↻ Повторить' }}
                </button>
              </div>
            </div>

            <!-- Пустое состояние -->
            <div
              v-else-if="!isLoading && items.length === 0"
              class="bg-white rounded-[14px] border border-gray-200 shadow-sm p-12 text-center"
            >
              <p class="text-gray-400 text-sm">Нет фото за выбранный период</p>
              <p class="text-gray-300 text-xs mt-1">Попробуйте изменить фильтры</p>
            </div>

            <!-- Сетка фото -->
            <template v-else>
              <PhotoFeedGrid
                :items="items"
                :group-by-azs="filters.groupByAzs"
                :loading="isLoading"
                :marked-keys="markedKeys"
                @open="handleOpen"
                @toggle-mark="handleToggleMark"
                @remark-info="handleRemarkInfo"
              />

              <!-- Сентинел автоподгрузки -->
              <div ref="sentinelRef" class="h-px mt-4" />

              <!-- Кнопка «Показать ещё» + скелетоны при подгрузке -->
              <div v-if="nextCursor" class="mt-4 flex flex-col items-center gap-3">
                <template v-if="isLoadingMore">
                  <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5 w-full">
                    <SkeletonBlock
                      v-for="n in 5"
                      :key="`more-skel-${n}`"
                      height="0"
                      rounded="rounded-[11px]"
                      class="aspect-[4/3]"
                    />
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

              <!-- Конец ленты -->
              <p v-else-if="!isLoading && items.length > 0" class="text-center text-xs text-gray-400 mt-6">
                Все фото загружены · {{ items.length }} шт.
              </p>
            </template>

            <!-- Inline-конфликт АЗС (С3) — поверх панели -->
            <div
              v-if="conflictItem"
              class="fixed bottom-0 left-0 right-0 z-[100] bg-amber-50 border-t border-amber-300 shadow-lg px-4 py-4"
            >
              <p class="text-sm font-semibold text-amber-800 mb-3">
                {{ conflictMessage }}
              </p>
              <div class="flex gap-2 flex-wrap">
                <button
                  class="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
                  @click="resolveConflictSendCurrentThenMark"
                >
                  Отправить текущее
                </button>
                <button
                  class="px-4 py-2 rounded-lg text-sm font-medium bg-white border border-amber-400 text-amber-800 hover:bg-amber-50 transition-colors"
                  @click="resolveConflictClearAndMark"
                >
                  Очистить и начать с этого фото
                </button>
                <button
                  class="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 transition-colors"
                  @click="conflictItem = null"
                >
                  Отмена
                </button>
              </div>
            </div>

            <!-- Панель черновика sticky снизу (при draftCount > 0, нет конфликта) -->
            <div
              v-else-if="draftCount > 0"
              class="fixed bottom-0 left-0 right-0 z-[90]"
            >
              <RemarkDraftPanel
                :count="draftCount"
                :azs-id="activeAzsId"
                :azs-title="draftAzsTitle"
                :manager="draftManager"
                :admin="draftAdmin"
                :recipients-loading="recipientsLoading"
                :templates="remarkTemplates"
                :is-sending="isSending"
                @send="handleSend"
                @clear="handleDraftClear"
              />
            </div>

          </main>
        </div>

      </div>
    </template>

    <!-- Полноэкранный лайтбокс -->
    <PhotoLightbox
      v-if="lightboxOpen"
      :items="items"
      :start-index="lightboxIndex"
      :marked-keys="markedKeys"
      :draft-count="draftCount"
      :draft-azs-id="activeAzsId"
      :draft-azs-title="draftAzsTitle"
      :draft-manager="draftManager"
      :draft-admin="draftAdmin"
      :draft-recipients-loading="recipientsLoading"
      :draft-templates="remarkTemplates"
      :draft-is-sending="isSending"
      :has-more="Boolean(nextCursor)"
      @close="handleLightboxClose"
      @toggle-mark="handleLightboxToggleMark"
      @need-more="handleLightboxNeedMore"
      @draft-send="handleSend"
      @draft-clear="handleDraftClear"
    />
  </div>
</template>
