<script setup lang="ts">
/**
 * PhotoFeedGrid — сетка тайлов aspect-[4/3] grid-cols-2 lg:grid-cols-5 (паттерн R5Wall).
 * Ленивая загрузка превью через IntersectionObserver.
 * Режим группировки «По АЗС» — секции с заголовком.
 */

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
  groupByAzs: boolean
  loading?: boolean
}>()

const emit = defineEmits<{
  (e: 'open', index: number): void
  (e: 'toggle-mark' | 'remark-info', item: PhotoFeedItem): void
}>()

const apiStore = useApiStore()

// ── Blob-превью ─────────────────────────────────────────────────────────
const previewUrls = ref(new Map<string, string>())
const previewsLoading = ref(new Set<string>())
const previewErrors = ref(new Set<string>())

const previewKey = (item: PhotoFeedItem) => `${item.reportId}:${item.photoCode}`

const loadPreview = async (item: PhotoFeedItem) => {
  const key = previewKey(item)
  if (previewUrls.value.has(key) || previewsLoading.value.has(key) || previewErrors.value.has(key)) return

  const nextLoading = new Set(previewsLoading.value)
  nextLoading.add(key)
  previewsLoading.value = nextLoading

  try {
    const url = await apiStore.getPhotoPreviewObjectUrl(item.reportId, item.photoCode)
    const nextUrls = new Map(previewUrls.value)
    nextUrls.set(key, url)
    previewUrls.value = nextUrls
  } catch {
    const nextErrors = new Set(previewErrors.value)
    nextErrors.add(key)
    previewErrors.value = nextErrors
  } finally {
    const nextLoading = new Set(previewsLoading.value)
    nextLoading.delete(key)
    previewsLoading.value = nextLoading
  }
}

const revokeAll = () => {
  for (const url of previewUrls.value.values()) {
    URL.revokeObjectURL(url)
  }
  previewUrls.value = new Map()
}

onBeforeUnmount(revokeAll)

// ── IntersectionObserver для ленивой загрузки ─────────────────────────
const tileRefs = ref<Map<string, HTMLElement>>(new Map())
let observer: IntersectionObserver | null = null

const setTileRef = (item: PhotoFeedItem, el: HTMLElement | null) => {
  const key = previewKey(item)
  if (el) {
    tileRefs.value.set(key, el)
    observer?.observe(el)
  } else {
    tileRefs.value.delete(key)
  }
}

const setupObserver = () => {
  if (typeof IntersectionObserver === 'undefined') return
  observer?.disconnect()
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const key = (entry.target as HTMLElement).dataset.previewKey
          if (!key) continue
          const item = props.items.find(i => previewKey(i) === key)
          if (item) void loadPreview(item)
        }
      }
    },
    { rootMargin: '100px' }
  )
  for (const el of tileRefs.value.values()) {
    observer.observe(el)
  }
}

onMounted(setupObserver)
onBeforeUnmount(() => observer?.disconnect())

// При изменении items — переподключаем наблюдение для новых элементов
watch(() => props.items.length, () => {
  nextTick(() => {
    for (const [key, el] of tileRefs.value.entries()) {
      if (!previewUrls.value.has(key) && !previewsLoading.value.has(key)) {
        observer?.observe(el)
      }
    }
  })
})

// ── Группировка «По АЗС» ─────────────────────────────────────────────
type AzsGroup = {
  azsId: string
  azsTitle: string
  items: PhotoFeedItem[]
}

const grouped = computed<AzsGroup[]>(() => {
  const map = new Map<string, AzsGroup>()
  for (const item of props.items) {
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

// ── Форматирование времени ────────────────────────────────────────────
const fmtTime = (iso: string | null): string => {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return '—'
  }
}

// ── Вычисление глобального индекса для emit('open') ───────────────────
const globalIndex = (item: PhotoFeedItem): number => {
  return props.items.indexOf(item)
}

const GRAD = 'linear-gradient(135deg,#6a8caf,#34506b)'

const handleRemarkBadgeClick = (e: Event, item: PhotoFeedItem) => {
  e.stopPropagation()
  emit('remark-info', item)
}

const handleToggleMark = (e: Event, item: PhotoFeedItem) => {
  e.stopPropagation()
  emit('toggle-mark', item)
}
</script>

<template>
  <div>
    <!-- Скелетоны первичной загрузки -->
    <template v-if="loading && items.length === 0">
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
        <SkeletonBlock
          v-for="n in 10"
          :key="`skel-${n}`"
          height="0"
          rounded="rounded-[11px]"
          class="aspect-[4/3]"
        />
      </div>
    </template>

    <!-- Режим: плоская сетка (без группировки) -->
    <template v-else-if="!groupByAzs">
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
        <div
          v-for="item in items"
          :key="previewKey(item)"
          :ref="(el) => setTileRef(item, el as HTMLElement | null)"
          :data-preview-key="previewKey(item)"
          class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white cursor-pointer group"
          :style="`background:${GRAD}`"
          @click="emit('open', globalIndex(item))"
        >
          <!-- Превью -->
          <img
            v-if="previewUrls.get(previewKey(item))"
            :src="previewUrls.get(previewKey(item))!"
            class="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
            :alt="item.photoCode"
            @error="($event.target as HTMLImageElement).style.display='none'"
          >

          <!-- Бейдж замечания -->
          <button
            v-if="item.remark"
            class="absolute top-2 left-2 bg-green-600/90 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold backdrop-blur-sm z-20 flex items-center gap-1"
            @click="handleRemarkBadgeClick($event, item)"
          >
            ✓ замечание
          </button>

          <!-- Флажок «Отметить» — зона ≥40px, stopPropagation -->
          <button
            class="absolute top-2 right-2 z-20 w-10 h-10 flex items-center justify-center bg-black/30 rounded-full hover:bg-black/50 transition-colors"
            aria-label="Отметить"
            @click="handleToggleMark($event, item)"
          >
            <span class="text-white text-base">⚑</span>
          </button>

          <!-- Подпись «№АЗС · категория · время» -->
          <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/55 to-transparent text-[11px] font-semibold leading-tight">
            <span class="opacity-80">№{{ item.azsId }}</span>
            <span class="opacity-60"> · </span>
            <span>{{ item.photoCode }}</span>
            <span class="opacity-60"> · </span>
            <span class="tabular-nums">{{ fmtTime(item.exifAt || item.uploadedAt) }}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- Режим: группировка по АЗС -->
    <template v-else>
      <div
        v-for="group in grouped"
        :key="group.azsId"
        class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5"
      >
        <!-- Заголовок секции -->
        <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
          <b class="text-[14px]">{{ group.azsTitle }}</b>
          <span class="text-[12.5px] text-gray-400">{{ group.items.length }} фото</span>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div
            v-for="item in group.items"
            :key="previewKey(item)"
            :ref="(el) => setTileRef(item, el as HTMLElement | null)"
            :data-preview-key="previewKey(item)"
            class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white cursor-pointer group"
            :style="`background:${GRAD}`"
            @click="emit('open', globalIndex(item))"
          >
            <img
              v-if="previewUrls.get(previewKey(item))"
              :src="previewUrls.get(previewKey(item))!"
              class="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              :alt="item.photoCode"
              @error="($event.target as HTMLImageElement).style.display='none'"
            >

            <button
              v-if="item.remark"
              class="absolute top-2 left-2 bg-green-600/90 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold backdrop-blur-sm z-20 flex items-center gap-1"
              @click="handleRemarkBadgeClick($event, item)"
            >
              ✓ замечание
            </button>

            <button
              class="absolute top-2 right-2 z-20 w-10 h-10 flex items-center justify-center bg-black/30 rounded-full hover:bg-black/50 transition-colors"
              aria-label="Отметить"
              @click="handleToggleMark($event, item)"
            >
              <span class="text-white text-base">⚑</span>
            </button>

            <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/55 to-transparent text-[11px] font-semibold leading-tight">
              <span>{{ item.photoCode }}</span>
              <span class="opacity-60"> · </span>
              <span class="tabular-nums">{{ fmtTime(item.exifAt || item.uploadedAt) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
