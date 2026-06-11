<script setup lang="ts">
/**
 * PhotoLightbox — полноэкранный просмотр фото (спека §4.2).
 * Телепорт в body, z-[210] (выше B24Modal z-[200]).
 * Свайпы pointer-событиями (порог 50px по X).
 * Предзагрузка n±1, revoke вне n±3.
 * Скролл body заблокирован пока открыт.
 * RemarkDraftPanel вставляется снизу при наличии черновика.
 */

import type { RemarkRecipient } from '~/components/photos/RemarkDraftPanel.vue'

type PhotoFeedItem = {
  reportId: number
  azsId: string
  azsTitle?: string | null
  photoCode: string
  exifAt: string | null
  uploadedAt: string | null
  remark: { dt: string; recipientName: string; message: string; senderName: string } | null
}

const props = defineProps<{
  items: PhotoFeedItem[]
  startIndex: number
  markedKeys: Set<string>
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
  draftTemplates: string[]
  draftIsSending: boolean
  /** true если есть ещё страницы */
  hasMore: boolean
}>()

const emit = defineEmits<{
  close: []
  'toggle-mark': [item: PhotoFeedItem]
  'need-more': []
  'draft-send': [payload: { recipientRole: 'manager' | 'admin'; message: string }]
  'draft-clear': []
}>()

const apiStore = useApiStore()

// ── Текущий индекс ────────────────────────────────────────────────────────
const currentIndex = ref(props.startIndex)

watch(() => props.startIndex, (val) => {
  currentIndex.value = val
})

const current = computed(() => props.items[currentIndex.value] ?? null)

const previewKey = (item: PhotoFeedItem) => `${item.reportId}:${item.photoCode}`

// ── Blob-кэш ─────────────────────────────────────────────────────────────
const blobUrls = ref(new Map<string, string>())
const loadingSet = ref(new Set<string>())

const loadBlob = async (item: PhotoFeedItem) => {
  const key = previewKey(item)
  if (blobUrls.value.has(key) || loadingSet.value.has(key)) return
  const nextLoading = new Set(loadingSet.value)
  nextLoading.add(key)
  loadingSet.value = nextLoading
  try {
    const url = await apiStore.getPhotoPreviewObjectUrl(item.reportId, item.photoCode)
    const next = new Map(blobUrls.value)
    next.set(key, url)
    blobUrls.value = next
  } catch {
    // silent — отображается placeholder
  } finally {
    const next = new Set(loadingSet.value)
    next.delete(key)
    loadingSet.value = next
  }
}

// Предзагрузка n±1, revoke вне n±3
const preloadAndRevoke = () => {
  const n = currentIndex.value
  const len = props.items.length

  // Preload n-1, n, n+1
  for (const offset of [-1, 0, 1]) {
    const idx = n + offset
    if (idx >= 0 && idx < len) {
      void loadBlob(props.items[idx])
    }
  }

  // Revoke вне n±3 (immutable pattern — создаём новый Map)
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
  // Если достигли конца и есть ещё страницы — запросить подгрузку
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

// ── Pointer-свайпы ────────────────────────────────────────────────────────
const SWIPE_THRESHOLD = 50
let pointerStartX = 0
let pointerStartY = 0
let isPointerDown = false

const onPointerDown = (e: PointerEvent) => {
  // Игнорировать взаимодействие с интерактивными элементами
  if ((e.target as HTMLElement).closest('button, a, textarea, select, input')) return
  pointerStartX = e.clientX
  pointerStartY = e.clientY
  isPointerDown = true
}

const onPointerUp = (e: PointerEvent) => {
  if (!isPointerDown) return
  isPointerDown = false
  const dx = e.clientX - pointerStartX
  const dy = e.clientY - pointerStartY
  // Только горизонтальные свайпы (|dx| > |dy| и выше порога)
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_THRESHOLD) {
    if (dx < 0) next()
    else prev()
  }
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
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKeyDown)
  // revoke все кэшированные blob-URLs
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

const isCurrentMarked = computed(() => {
  if (!current.value) return false
  return props.markedKeys.has(previewKey(current.value))
})

// ── Панель черновика видна ────────────────────────────────────────────────
const showDraftPanel = computed(() => props.draftCount > 0)
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[210] flex flex-col bg-black/95 select-none"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
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

        <!-- Кнопка «Отметить / Отмечено» -->
        <button
          v-if="current"
          class="px-3 py-1.5 rounded-full text-sm font-semibold transition-colors"
          :class="isCurrentMarked
            ? 'bg-blue-500 text-white'
            : 'bg-white/15 text-white hover:bg-white/25'"
          @click="current && emit('toggle-mark', current)"
        >
          {{ isCurrentMarked ? '⚑ Отмечено' : '⚑ Отметить' }}
        </button>
      </div>

      <!-- Основное фото -->
      <div class="flex-1 relative flex items-center justify-center overflow-hidden min-h-0">

        <!-- Спиннер загрузки -->
        <div
          v-if="isCurrentLoading"
          class="absolute inset-0 flex items-center justify-center"
        >
          <div class="w-10 h-10 border-4 border-white/20 border-t-white rounded-full animate-spin" />
        </div>

        <!-- Фото -->
        <img
          v-if="currentUrl"
          :src="currentUrl"
          class="max-h-full max-w-full object-contain pointer-events-none"
          :alt="current?.photoCode"
        >

        <!-- Placeholder если нет blob -->
        <div
          v-else-if="!isCurrentLoading"
          class="text-white/30 text-sm"
        >
          Фото не загружено
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
        <span class="opacity-50">·</span>
        <span>{{ current.photoCode }}</span>
        <span class="opacity-50">·</span>
        <span class="tabular-nums">{{ fmtDateTime(current.exifAt || current.uploadedAt) }}</span>

        <!-- Инфо-строка отправленного замечания -->
        <template v-if="current.remark">
          <span class="opacity-50">·</span>
          <span class="text-green-400 font-medium">
            ✓ {{ fmtDateTime(current.remark.dt) }} → {{ current.remark.recipientName }}: «{{ current.remark.message }}» — {{ current.remark.senderName }}
          </span>
        </template>
      </div>

      <!-- Панель черновика снизу (видна если draftCount > 0) -->
      <div
        v-if="showDraftPanel"
        class="flex-shrink-0"
      >
        <RemarkDraftPanel
          :count="draftCount"
          :azs-id="draftAzsId"
          :azs-title="draftAzsTitle"
          :manager="draftManager"
          :admin="draftAdmin"
          :recipients-loading="draftRecipientsLoading"
          :templates="draftTemplates"
          :is-sending="draftIsSending"
          @send="emit('draft-send', $event)"
          @clear="emit('draft-clear')"
        />
      </div>

    </div>
  </Teleport>
</template>
