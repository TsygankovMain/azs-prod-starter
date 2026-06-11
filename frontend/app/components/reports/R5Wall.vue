<script setup lang="ts">
import { DateTime } from 'luxon'

const apiStore = useApiStore()
const date = ref(DateTime.utc().toISODate() ?? '')
const azsFilter = ref<Set<string>>(new Set())
type Entry = {
  reportId: number; azsId: string; azsTitle?: string | null; doneAt: string | null
  photos: Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null }>
}
const items = ref<Entry[]>([])
const loading = ref(false); const error = ref('')

// Blob preview map: key = `${reportId}:${photoCode}` -> object URL
const previewUrls = ref(new Map<string, string>())
const previewsLoading = ref(new Set<string>())

const getPreviewKey = (reportId: number, photoCode: string) => `${reportId}:${photoCode}`

const loadPhotoPreview = async (reportId: number, photoCode: string) => {
  const key = getPreviewKey(reportId, photoCode)
  if (previewUrls.value.has(key) || previewsLoading.value.has(key)) return
  previewsLoading.value = new Set([...previewsLoading.value, key])
  try {
    const url = await apiStore.getPhotoPreviewObjectUrl(reportId, photoCode)
    const next = new Map(previewUrls.value)
    next.set(key, url)
    previewUrls.value = next
  } catch {
    // Деградация до плейсхолдера: не добавляем в карту, тайл остаётся с градиентом
  } finally {
    const next = new Set(previewsLoading.value)
    next.delete(key)
    previewsLoading.value = next
  }
}

const revokeAllPreviews = () => {
  for (const url of previewUrls.value.values()) {
    URL.revokeObjectURL(url)
  }
  previewUrls.value = new Map()
}

onBeforeUnmount(() => {
  revokeAllPreviews()
})

const load = async () => {
  loading.value = true; error.value = ''
  revokeAllPreviews()
  try {
    const resp = await apiStore.getDayPhotos({ date: date.value })
    items.value = resp.items
    // Запустить загрузку превью для всех фото
    for (const entry of resp.items) {
      for (const photo of entry.photos) {
        void loadPhotoPreview(entry.reportId, photo.photoCode)
      }
    }
  } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
  finally { loading.value = false }
}

const azsIds = computed(() => [...new Set(items.value.map(i => i.azsId))])
const displayed = computed(() => {
  if (!azsFilter.value.size) return items.value
  return items.value.filter(i => azsFilter.value.has(i.azsId))
})

const toggleAzs = (id: string) => {
  const next = new Set(azsFilter.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  azsFilter.value = next
}

const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'

const GRAD = 'linear-gradient(135deg,#6a8caf,#34506b)'

onMounted(load)
watch(date, load)
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h1 class="text-[21px] font-semibold">Фото-витрина дня</h1>
        <p class="text-sm text-gray-500 mt-0.5">Все сданные сегодня фото в одном экране — видно порядок «как есть»</p>
      </div>
      <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: report_photo + Bitrix Disk</span>
    </div>

    <!-- Выбор даты -->
    <div class="flex gap-2.5 mb-4 items-center flex-wrap">
      <input type="date" v-model="date"
        class="px-3 py-2 rounded-[10px] border border-gray-200 bg-white text-[13px] shadow-sm"
      />
      <button
        class="px-3 py-2 rounded-[10px] border border-gray-200 bg-white text-[13px] text-gray-600 hover:bg-gray-50 shadow-sm"
        @click="date = DateTime.utc().toISODate() ?? ''; load()"
      >Сегодня</button>
    </div>

    <!-- Чипы фильтра по АЗС -->
    <div class="flex gap-1.5 flex-wrap mb-4">
      <button
        :class="['border border-gray-200 rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors', !azsFilter.size ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-[#46586c] hover:bg-gray-50']"
        @click="azsFilter = new Set()"
      >Все АЗС</button>
      <button
        v-for="id in azsIds" :key="id"
        :class="['border rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors', azsFilter.has(id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-[#46586c] border-gray-200 hover:bg-gray-50']"
        @click="toggleAzs(id)"
      >{{ items.find(i => i.azsId === id)?.azsTitle || `АЗС ${id}` }}</button>
    </div>

    <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
    <div v-else-if="error" class="flex flex-col gap-2">
      <B24Alert color="air-primary-alert" :description="error" />
      <div>
        <button
          class="px-4 py-2 rounded-[10px] border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-[13px] font-medium shadow-sm"
          @click="load"
        >
          ↻ Повторить
        </button>
      </div>
    </div>
    <div v-else-if="!displayed.length" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-8 text-center text-gray-400">
      Нет сданных отчётов под выбранный фильтр
    </div>
    <template v-else>
      <div v-for="entry in displayed" :key="entry.reportId" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
        <div class="flex items-center justify-between flex-wrap gap-2 mb-3">
          <b class="text-[14px]">{{ entry.azsTitle || `АЗС ${entry.azsId}` }}</b>
          <span class="text-[12.5px] text-gray-400">сдано в {{ fmtTime(entry.doneAt) }} · {{ entry.photos.length }} фото</span>
        </div>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div
            v-for="photo in entry.photos" :key="photo.photoCode"
            class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white"
            :style="`background:${GRAD}`"
          >
            <img
              v-if="previewUrls.get(getPreviewKey(entry.reportId, photo.photoCode))"
              :src="previewUrls.get(getPreviewKey(entry.reportId, photo.photoCode))!"
              class="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              :alt="photo.photoCode"
              @error="($event.target as HTMLImageElement).style.display='none'"
            />
            <div v-if="photo.exifAt" class="absolute top-2 right-2 bg-black/45 text-[10.5px] px-1.5 py-0.5 rounded-full font-bold backdrop-blur-sm">
              📷 {{ fmtTime(photo.exifAt) }}
            </div>
            <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/45 to-transparent text-[12px] font-semibold">
              {{ photo.photoCode }}
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
