<script setup lang="ts">
/**
 * PhotoLightbox — полноэкранный просмотр фото (спека §4.2, UX-2).
 * Телепорт в body, z-[210] (выше B24Modal z-[200]).
 * Свайпы pointer-событиями (порог 50px по X).
 * Предзагрузка n±1, revoke вне n±3.
 * Скролл body заблокирован пока открыт.
 * RemarkDraftPanel вставляется снизу при наличии черновика.
 * Поле комментария + «Отметить с замечанием» у каждого фото.
 */

import type { RemarkRecipient } from '~/components/photos/RemarkDraftPanel.vue'

type PhotoFeedItem = {
  reportId: number
  azsId: string
  azsTitle?: string | null
  azsAddress?: string | null
  photoCode: string
  exifAt: string | null
  uploadedAt: string | null
  remark: { createdAt: string | null; recipientName: string; message: string; senderName: string } | null
}

type MarkEntry = {
  reportId: number
  photoCode: string
  azsId: string
  azsTitle: string
  comment: string
}

const props = defineProps<{
  items: PhotoFeedItem[]
  startIndex: number
  markedKeys: Set<string>
  /** Map отмеченных фото с комментариями */
  marks: Map<string, MarkEntry>
  /** Map от photoCode → человеческое название категории */
  categoryTitles?: Map<string, string>
  /** Кол-во отмеченных фото в черновике */
  draftCount: number
  /** AZS id черновика */
  draftAzsId: string
  /** AZS title черновика */
  draftAzsTitle: string
  /** Получатели */
  draftManager: RemarkRecipient
  draftAdmin: RemarkRecipient
  draftRecipientsLoading: boolean
  /** Шаблоны комментариев */
  draftTemplates: string[]
  draftIsSending: boolean
  /** Текст ошибки отправки замечания — показывается инлайн в панели (видна при открытом лайтбоксе) */
  draftSendError?: string
  /** true если есть ещё страницы */
  hasMore: boolean
  /** Конфликт-промпт (С3) */
  conflictItem?: PhotoFeedItem | null
  conflictMessage?: string
}>()

const emit = defineEmits<{
  close: []
  'toggle-mark': [item: PhotoFeedItem]
  'mark-with-comment': [payload: { item: PhotoFeedItem; comment: string }]
  'need-more': []
  'draft-send': [payload: { recipientRole: 'manager' | 'admin' }]
  'draft-clear': []
  'update-comment': [payload: { key: string; comment: string }]
  'remove-mark': [key: string]
  'resolve-conflict-back': []
  'resolve-conflict-clear': []
  'resolve-conflict-cancel': []
}>()

const apiStore = useApiStore()

// ── Зум-состояние ─────────────────────────────────────────────────────────
const zoomScale = ref(1)
const zoomTx = ref(0)
const zoomTy = ref(0)

const SCALE_MIN = 1
const SCALE_MAX = 5
const DOUBLE_TAP_TARGET = 2.5

/** CSS-трансформ для zoom-wrapper */
const zoomTransform = computed(() =>
  `translate(${zoomTx.value}px, ${zoomTy.value}px) scale(${zoomScale.value})`
)

/** Ограничение сдвига, чтобы фото не уехало за края контейнера */
const clampPan = (tx: number, ty: number, scale: number, containerW: number, containerH: number, imgW: number, imgH: number) => {
  const maxX = Math.max(0, (imgW * scale - containerW) / 2)
  const maxY = Math.max(0, (imgH * scale - containerH) / 2)
  return {
    tx: Math.max(-maxX, Math.min(maxX, tx)),
    ty: Math.max(-maxY, Math.min(maxY, ty)),
  }
}

/** Сброс зума при смене фото */
const resetZoom = () => {
  zoomScale.value = 1
  zoomTx.value = 0
  zoomTy.value = 0
}

// ── Текущий индекс ────────────────────────────────────────────────────────
const currentIndex = ref(props.startIndex)

watch(() => props.startIndex, (val) => {
  currentIndex.value = val
})

// Сбрасываем зум при смене фото
watch(currentIndex, () => {
  resetZoom()
})

const current = computed(() => props.items[currentIndex.value] ?? null)

const previewKey = (item: PhotoFeedItem) => `${item.reportId}:${item.photoCode}`

// ── Blob-кэш ─────────────────────────────────────────────────────────────
const blobUrls = ref(new Map<string, string>())
const loadingSet = ref(new Set<string>())
const errorSet = ref(new Set<string>())

const loadBlob = async (item: PhotoFeedItem) => {
  const key = previewKey(item)
  if (blobUrls.value.has(key) || loadingSet.value.has(key) || errorSet.value.has(key)) return
  const nextLoading = new Set(loadingSet.value)
  nextLoading.add(key)
  loadingSet.value = nextLoading
  try {
    const url = await apiStore.getPhotoPreviewObjectUrl(item.reportId, item.photoCode)
    const next = new Map(blobUrls.value)
    next.set(key, url)
    blobUrls.value = next
  } catch {
    const nextErr = new Set(errorSet.value)
    nextErr.add(key)
    errorSet.value = nextErr
  } finally {
    const next = new Set(loadingSet.value)
    next.delete(key)
    loadingSet.value = next
  }
}

const retryCurrentBlob = () => {
  if (!current.value) return
  const key = previewKey(current.value)
  if (errorSet.value.has(key)) {
    const next = new Set(errorSet.value)
    next.delete(key)
    errorSet.value = next
  }
  void loadBlob(current.value)
}

// Предзагрузка n±1, revoke вне n±3
const preloadAndRevoke = () => {
  const n = currentIndex.value
  const len = props.items.length

  for (const offset of [-1, 0, 1]) {
    const idx = n + offset
    if (idx >= 0 && idx < len) {
      void loadBlob(props.items[idx])
    }
  }

  const keepFrom = Math.max(0, n - 3)
  const keepTo = Math.min(len - 1, n + 3)
  const toRevoke: string[] = []
  for (const [key, url] of blobUrls.value.entries()) {
    const itemIdx = props.items.findIndex(i => previewKey(i) === key)
    if (itemIdx < keepFrom || itemIdx > keepTo) {
      URL.revokeObjectURL(url)
      toRevoke.push(key)
    }
  }
  if (toRevoke.length > 0) {
    const next = new Map(blobUrls.value)
    for (const key of toRevoke) next.delete(key)
    blobUrls.value = next
  }
}

watch(currentIndex, () => {
  preloadAndRevoke()
  if (currentIndex.value >= props.items.length - 2 && props.hasMore) {
    emit('need-more')
  }
}, { immediate: true })

// ── Навигация ─────────────────────────────────────────────────────────────
const prev = () => {
  if (currentIndex.value > 0) currentIndex.value--
}

const next = () => {
  if (currentIndex.value < props.items.length - 1) currentIndex.value++
}

// ── Pointer-свайпы + зум-жесты ────────────────────────────────────────────
const SWIPE_THRESHOLD = 50

// Активные указатели для pinch (Map: pointerId → {x, y})
const activePointers = new Map<number, { x: number; y: number }>()

// Pan-состояние (один указатель при scale>1)
let panActive = false
let panStartX = 0
let panStartY = 0
let panStartTx = 0
let panStartTy = 0

// Свайп-состояние (один указатель при scale==1)
let swipeActive = false
let swipeStartX = 0
let swipeStartY = 0

// Pinch-состояние (два указателя)
let pinchStartDist = 0
let pinchStartScale = 1
let pinchStartTx = 0
let pinchStartTy = 0
let pinchCenterX = 0
let pinchCenterY = 0

// Ссылка на zoom-контейнер для clamp
const zoomContainerRef = ref<HTMLElement | null>(null)

/** Возвращает размер контейнера и img для clamp */
const getZoomDimensions = () => {
  const container = zoomContainerRef.value
  if (!container) return { cw: window.innerWidth, ch: window.innerHeight, iw: window.innerWidth, ih: window.innerHeight }
  const cw = container.clientWidth
  const ch = container.clientHeight
  const img = container.querySelector('img')
  const iw = img ? img.naturalWidth || img.clientWidth : cw
  const ih = img ? img.naturalHeight || img.clientHeight : ch
  // Учитываем object-contain масштабирование
  const imgDisplayRatio = Math.min(cw / iw, ch / ih, 1)
  return { cw, ch, iw: iw * imgDisplayRatio, ih: ih * imgDisplayRatio }
}

const getPointerDist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(b.x - a.x, b.y - a.y)

const isInteractive = (target: EventTarget | null) =>
  !!(target as HTMLElement | null)?.closest('button, a, textarea, select, input')

const onPointerDown = (e: PointerEvent) => {
  if (isInteractive(e.target)) return

  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

  if (activePointers.size === 2) {
    // Начинаем pinch — отменяем свайп/pan
    swipeActive = false
    panActive = false
    const pts = [...activePointers.values()]
    pinchStartDist = getPointerDist(pts[0], pts[1])
    pinchStartScale = zoomScale.value
    pinchStartTx = zoomTx.value
    pinchStartTy = zoomTy.value
    pinchCenterX = (pts[0].x + pts[1].x) / 2
    pinchCenterY = (pts[0].y + pts[1].y) / 2
  } else if (activePointers.size === 1) {
    if (zoomScale.value > 1) {
      // Pan при zoom
      panActive = true
      panStartX = e.clientX
      panStartY = e.clientY
      panStartTx = zoomTx.value
      panStartTy = zoomTy.value
    } else {
      // Свайп только при scale==1
      swipeActive = true
      swipeStartX = e.clientX
      swipeStartY = e.clientY
    }
  }
}

const onPointerMove = (e: PointerEvent) => {
  if (isInteractive(e.target)) return
  if (!activePointers.has(e.pointerId)) return

  activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

  if (activePointers.size === 2) {
    // Pinch
    const pts = [...activePointers.values()]
    const dist = getPointerDist(pts[0], pts[1])
    if (pinchStartDist === 0) return
    const newScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, pinchStartScale * (dist / pinchStartDist)))
    const { cw, ch, iw, ih } = getZoomDimensions()
    // Масштабирование относительно центра pinch
    const container = zoomContainerRef.value
    const containerRect = container?.getBoundingClientRect()
    const localCx = pinchCenterX - (containerRect?.left ?? 0) - cw / 2
    const localCy = pinchCenterY - (containerRect?.top ?? 0) - ch / 2
    const scaleRatio = newScale / pinchStartScale
    const newTx = localCx + (pinchStartTx - localCx) * scaleRatio
    const newTy = localCy + (pinchStartTy - localCy) * scaleRatio
    const clamped = clampPan(newTx, newTy, newScale, cw, ch, iw, ih)
    zoomScale.value = newScale
    zoomTx.value = clamped.tx
    zoomTy.value = clamped.ty
  } else if (activePointers.size === 1 && panActive) {
    // Pan
    const rawTx = panStartTx + (e.clientX - panStartX)
    const rawTy = panStartTy + (e.clientY - panStartY)
    const { cw, ch, iw, ih } = getZoomDimensions()
    const clamped = clampPan(rawTx, rawTy, zoomScale.value, cw, ch, iw, ih)
    zoomTx.value = clamped.tx
    zoomTy.value = clamped.ty
  }
}

const onPointerUp = (e: PointerEvent) => {
  const wasSwipeActive = swipeActive && activePointers.size === 1
  const swipeEndX = e.clientX
  const swipeEndY = e.clientY

  activePointers.delete(e.pointerId)

  if (wasSwipeActive && zoomScale.value === 1) {
    swipeActive = false
    const dx = swipeEndX - swipeStartX
    const dy = swipeEndY - swipeStartY
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
      if (dx < 0) next()
      else prev()
    }
  }

  if (activePointers.size < 2) {
    pinchStartDist = 0
  }
  if (activePointers.size === 0) {
    panActive = false
    swipeActive = false
  }
}

const onPointerCancel = (e: PointerEvent) => {
  activePointers.delete(e.pointerId)
  if (activePointers.size === 0) {
    panActive = false
    swipeActive = false
    pinchStartDist = 0
  }
}

// ── Двойной тап / двойной клик ────────────────────────────────────────────
let lastTapTime = 0
let lastTapX = 0
let lastTapY = 0

const onDoubleTapOrClick = (e: MouseEvent | PointerEvent) => {
  if (isInteractive(e.target)) return
  const now = Date.now()
  const dx = e.clientX - lastTapX
  const dy = e.clientY - lastTapY
  const isSameSpot = Math.hypot(dx, dy) < 30

  if (now - lastTapTime < 350 && isSameSpot) {
    // Double tap detected
    lastTapTime = 0
    const container = zoomContainerRef.value
    const containerRect = container?.getBoundingClientRect()
    const cw = container?.clientWidth ?? window.innerWidth
    const ch = container?.clientHeight ?? window.innerHeight
    const localX = e.clientX - (containerRect?.left ?? 0) - cw / 2
    const localY = e.clientY - (containerRect?.top ?? 0) - ch / 2

    if (zoomScale.value > 1) {
      // Сброс к 1×
      resetZoom()
    } else {
      // Zoom к точке тапа → ~2.5×
      const newScale = DOUBLE_TAP_TARGET
      const { cw: dw, ch: dh, iw, ih } = getZoomDimensions()
      const newTx = -localX * (newScale - 1)
      const newTy = -localY * (newScale - 1)
      const clamped = clampPan(newTx, newTy, newScale, dw, dh, iw, ih)
      zoomScale.value = newScale
      zoomTx.value = clamped.tx
      zoomTy.value = clamped.ty
    }
  } else {
    lastTapTime = now
    lastTapX = e.clientX
    lastTapY = e.clientY
  }
}

// ── Колесо мыши (десктоп) ─────────────────────────────────────────────────
const onWheel = (e: WheelEvent) => {
  if (isInteractive(e.target)) return
  e.preventDefault()
  const container = zoomContainerRef.value
  const containerRect = container?.getBoundingClientRect()
  const cw = container?.clientWidth ?? window.innerWidth
  const ch = container?.clientHeight ?? window.innerHeight
  const localX = e.clientX - (containerRect?.left ?? 0) - cw / 2
  const localY = e.clientY - (containerRect?.top ?? 0) - ch / 2

  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  const newScale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, zoomScale.value * factor))
  const scaleRatio = newScale / zoomScale.value
  const newTx = localX + (zoomTx.value - localX) * scaleRatio
  const newTy = localY + (zoomTy.value - localY) * scaleRatio
  const { iw, ih } = getZoomDimensions()
  const clamped = clampPan(newTx, newTy, newScale, cw, ch, iw, ih)
  zoomScale.value = newScale
  zoomTx.value = clamped.tx
  zoomTy.value = clamped.ty
}

// ── Клавиши ───────────────────────────────────────────────────────────────
const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close')
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}

// ── Блокировка скролла body ───────────────────────────────────────────────
onMounted(() => {
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKeyDown)
  // Wheel нужен non-passive чтобы preventDefault() работал
  zoomContainerRef.value?.addEventListener('wheel', onWheel, { passive: false })
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKeyDown)
  zoomContainerRef.value?.removeEventListener('wheel', onWheel)
  activePointers.clear()
  for (const url of blobUrls.value.values()) {
    URL.revokeObjectURL(url)
  }
})

// ── Форматирование ────────────────────────────────────────────────────────
const fmtDateTime = (iso: string | null): string => {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return '—'
  }
}

// ── Текущее изображение ───────────────────────────────────────────────────
const currentUrl = computed(() => {
  if (!current.value) return null
  return blobUrls.value.get(previewKey(current.value)) ?? null
})

const isCurrentLoading = computed(() => {
  if (!current.value) return false
  return loadingSet.value.has(previewKey(current.value))
})

const isCurrentError = computed(() => {
  if (!current.value) return false
  return errorSet.value.has(previewKey(current.value))
})

// ── Маппинг категорий ─────────────────────────────────────────────────────
const getCategoryTitle = (code: string): string => {
  return props.categoryTitles?.get(code) ?? code
}

const isCurrentMarked = computed(() => {
  if (!current.value) return false
  return props.markedKeys.has(previewKey(current.value))
})

// ── Поле комментария для текущего фото ────────────────────────────────────
// При переходе к фото: если уже отмечено — показать его коммент, иначе пусто
const localComment = ref('')

watch(
  [currentIndex, () => props.marks],
  () => {
    if (!current.value) return
    const key = previewKey(current.value)
    const entry = props.marks.get(key)
    localComment.value = entry ? entry.comment : ''
  },
  { immediate: true }
)

// Шаблон применяется к полю текущего фото
const applyTemplate = (tmpl: string) => {
  localComment.value = tmpl
  // Если фото уже в черновике — обновить коммент сразу
  if (current.value && isCurrentMarked.value) {
    const key = previewKey(current.value)
    emit('update-comment', { key, comment: tmpl })
  }
}

// «Отметить с замечанием» — добавляет фото с введённым комментарием
const handleMarkWithComment = () => {
  if (!current.value) return
  if (isCurrentMarked.value) {
    // Снять отметку
    emit('toggle-mark', current.value)
    localComment.value = ''
  } else {
    emit('mark-with-comment', { item: current.value, comment: localComment.value })
  }
}

// Обновить коммент при вводе если фото уже отмечено
const handleCommentInput = (e: Event) => {
  const val = (e.target as HTMLTextAreaElement).value
  localComment.value = val
  if (current.value && isCurrentMarked.value) {
    const key = previewKey(current.value)
    emit('update-comment', { key, comment: val })
  }
}

// ── Панель черновика видна ────────────────────────────────────────────────
const showDraftPanel = computed(() => props.draftCount > 0 && !props.conflictItem)

// ── Управляемый state роли (поднят в родителя) ───────────────────────────
const draftRole = defineModel<'manager' | 'admin'>('draftRole', { default: 'manager' })
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[210] flex flex-col bg-black/95 select-none"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerCancel"
      @click="onDoubleTapOrClick"
    >

      <!-- Шапка: крестик + счётчик + кнопка отметить -->
      <div class="flex items-center justify-between px-4 py-3 flex-shrink-0 bg-black/60 backdrop-blur-sm">
        <button
          class="w-9 h-9 flex items-center justify-center rounded-full text-white hover:bg-white/10 transition-colors"
          aria-label="Закрыть"
          @click="emit('close')"
        >
          ✕
        </button>

        <!-- Счётчик -->
        <span class="text-white/70 text-sm tabular-nums">
          {{ currentIndex + 1 }} / {{ items.length }}{{ hasMore ? '+' : '' }}
        </span>

        <!-- Счётчик черновика -->
        <span
          v-if="draftCount > 0"
          class="text-xs px-2 py-1 rounded-full bg-blue-500 text-white font-semibold"
        >
          {{ draftCount }} в черновике
        </span>
        <span v-else class="w-16" />
      </div>

      <!-- Основное фото -->
      <div
        ref="zoomContainerRef"
        class="flex-1 relative flex items-center justify-center overflow-hidden min-h-0"
        :style="{ touchAction: zoomScale > 1 ? 'none' : 'pan-y' }"
      >

        <!-- Спиннер загрузки -->
        <div
          v-if="isCurrentLoading"
          class="absolute inset-0 flex items-center justify-center"
        >
          <div class="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
        </div>

        <!-- Zoom-wrapper + Фото -->
        <div
          v-if="currentUrl"
          :style="{ transform: zoomTransform, transformOrigin: '50% 50%', willChange: 'transform' }"
          class="flex items-center justify-center"
        >
          <img
            :src="currentUrl"
            class="max-h-full max-w-full object-contain"
            :style="{ maxHeight: 'inherit', maxWidth: 'inherit' }"
            draggable="false"
            :alt="current?.photoCode"
          >
        </div>

        <!-- Ошибка загрузки с кнопкой «Повторить» -->
        <div
          v-else-if="isCurrentError"
          class="flex flex-col items-center justify-center gap-3 text-white/70"
        >
          <span class="text-4xl opacity-60">⚠</span>
          <p class="text-sm font-medium">Не удалось загрузить фото</p>
          <button
            class="px-5 py-2 rounded-full bg-white/15 hover:bg-white/25 text-white text-sm font-semibold transition-colors"
            @click.stop="retryCurrentBlob"
          >
            ↻ Повторить
          </button>
        </div>

        <!-- Placeholder если нет blob и нет ошибки -->
        <div
          v-else-if="!isCurrentLoading"
          class="text-white/30 text-sm"
        >
          Фото не загружено
        </div>

        <!-- Индикатор кратности (показывается при scale > 1) -->
        <button
          v-if="zoomScale > 1"
          class="absolute top-2.5 right-2.5 flex items-center gap-1 px-2.5 py-1 rounded-full bg-cyan-500/90 text-white text-xs font-semibold pointer-events-auto"
          aria-label="Сбросить масштаб"
          @click.stop="resetZoom"
        >
          🔍 {{ zoomScale.toFixed(1) }}×
        </button>

        <!-- Подсказка жеста (показывается один раз пока scale==1) -->
        <div
          v-if="zoomScale === 1 && currentUrl"
          class="absolute bottom-2.5 left-1/2 -translate-x-1/2 text-xs text-white/60 bg-black/40 px-2.5 py-1 rounded-full pointer-events-none whitespace-nowrap"
        >
          разведите пальцами · двойной тап
        </div>

        <!-- Стрелка влево -->
        <button
          v-if="currentIndex > 0"
          class="absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors text-xl"
          aria-label="Предыдущее"
          @click.stop="prev"
        >
          ‹
        </button>

        <!-- Стрелка вправо -->
        <button
          v-if="currentIndex < items.length - 1"
          class="absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors text-xl"
          aria-label="Следующее"
          @click.stop="next"
        >
          ›
        </button>
      </div>

      <!-- Подпись: АЗС · категория · время -->
      <div
        v-if="current"
        class="flex-shrink-0 px-4 py-2 bg-black/60 text-white/80 text-xs flex items-center gap-1.5 flex-wrap"
      >
        <span class="font-semibold">{{ current.azsTitle || `АЗС ${current.azsId}` }}</span>
        <template v-if="current.azsAddress">
          <span class="opacity-40">—</span>
          <span class="text-blue-200/80 font-normal">{{ current.azsAddress }}</span>
        </template>
        <span class="opacity-50">·</span>
        <span>{{ getCategoryTitle(current.photoCode) }}</span>
        <span class="opacity-50">·</span>
        <span class="tabular-nums">{{ fmtDateTime(current.exifAt || current.uploadedAt) }}</span>

        <!-- Инфо-строка отправленного замечания -->
        <template v-if="current.remark">
          <span class="opacity-50">·</span>
          <span class="text-green-400 font-medium">
            ✓ {{ fmtDateTime(current.remark.createdAt) }} → {{ current.remark.recipientName }}: «{{ current.remark.message }}» — {{ current.remark.senderName }}
          </span>
        </template>
      </div>

      <!-- Блок комментария к текущему фото + кнопка отметить -->
      <div
        v-if="current"
        class="flex-shrink-0 bg-black/70 px-4 py-3 space-y-2"
      >
        <!-- Шаблоны -->
        <div
          v-if="draftTemplates.length > 0"
          class="flex flex-wrap gap-1.5"
        >
          <button
            v-for="tmpl in draftTemplates"
            :key="tmpl"
            class="px-2.5 py-1 text-xs rounded-full border border-white/20 bg-white/10 hover:bg-white/20 text-white/80 transition-colors"
            @click.stop="applyTemplate(tmpl)"
          >
            {{ tmpl }}
          </button>
        </div>

        <div class="flex items-end gap-2">
          <textarea
            :value="localComment"
            rows="2"
            placeholder="Комментарий к этому фото…"
            class="flex-1 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
            @input="handleCommentInput"
          />
          <button
            class="flex-shrink-0 px-4 py-2 rounded-xl text-sm font-semibold transition-colors"
            :class="isCurrentMarked
              ? 'bg-blue-500 text-white hover:bg-blue-600'
              : 'bg-white/15 text-white hover:bg-white/25'"
            @click.stop="handleMarkWithComment"
          >
            {{ isCurrentMarked ? '⚑ Отмечено' : '⚑ Отметить с замечанием' }}
          </button>
        </div>
        <p
          v-if="isCurrentMarked && !localComment.trim()"
          class="text-xs text-amber-300"
        >
          Добавьте комментарий перед отправкой
        </p>
      </div>

      <!-- Конфликт-промпт С3 внутри лайтбокса -->
      <div
        v-if="conflictItem"
        class="flex-shrink-0 bg-amber-50 border-t border-amber-300 shadow-lg px-4 py-4"
      >
        <p class="text-sm font-semibold text-amber-800 mb-3">
          {{ conflictMessage }}
        </p>
        <div class="flex gap-2 flex-wrap">
          <button
            class="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 text-white hover:bg-amber-700 transition-colors"
            @click="emit('resolve-conflict-back')"
          >
            Вернуться к черновику
          </button>
          <button
            class="px-4 py-2 rounded-lg text-sm font-medium bg-white border border-amber-400 text-amber-800 hover:bg-amber-50 transition-colors"
            @click="emit('resolve-conflict-clear')"
          >
            Очистить и начать с этого фото
          </button>
          <button
            class="px-4 py-2 rounded-lg text-sm font-medium text-gray-500 hover:bg-gray-100 transition-colors"
            @click="emit('resolve-conflict-cancel')"
          >
            Отмена
          </button>
        </div>
      </div>

      <!-- Панель черновика снизу (видна если draftCount > 0 и нет конфликта) -->
      <div
        v-if="showDraftPanel"
        class="flex-shrink-0"
      >
        <!-- Ошибка отправки — инлайн внутри лайтбокса (тост невидим под z-[210]) -->
        <div
          v-if="draftSendError"
          class="bg-red-50 border-t border-red-300 px-4 py-2 text-sm text-red-700 font-medium"
        >
          ✕ {{ draftSendError }}
        </div>
        <RemarkDraftPanel
          v-model:selected-role="draftRole"
          :marks="marks"
          :azs-id="draftAzsId"
          :azs-title="draftAzsTitle"
          :manager="draftManager"
          :admin="draftAdmin"
          :recipients-loading="draftRecipientsLoading"
          :is-sending="draftIsSending"
          @send="emit('draft-send', $event)"
          @clear="emit('draft-clear')"
          @update-comment="emit('update-comment', $event)"
          @remove-mark="emit('remove-mark', $event)"
        />
      </div>

    </div>
  </Teleport>
</template>
