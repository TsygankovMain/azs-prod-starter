<script setup lang="ts">
import { DateTime } from 'luxon'

const apiStore = useApiStore()

type AzsOption = { value: string; label: string }
const azsOptions = ref<AzsOption[]>([])
const azsOptionsError = ref(false)
const azsOptionsLoading = ref(false)
const selectedAzsId = ref('')
const reportHistory = ref<Array<{
  id: number; status: string; scheduledAt: string | null; deadlineAt: string | null; updatedAt: string | null
}>>([])
const lastReportPhotos = ref<Array<{ photoCode: string; diskObjectId: number | null; diskFolderId: number | null; exifAt: string | null }>>([])
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
    // Деградация до плейсхолдера: просто не добавляем в карту
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

const lastDoneReport = computed(() => reportHistory.value.find(r => r.status === 'done') || null)

const load = async () => {
  if (!selectedAzsId.value) return
  const now = DateTime.utc()
  loading.value = true; error.value = ''
  revokeAllPreviews()
  try {
    const resp = await apiStore.getReports({
      dateFrom: now.minus({ days: 29 }).toISODate(),
      dateTo: now.toISODate(),
      azsId: selectedAzsId.value,
      limit: 50
    })
    reportHistory.value = resp.items

    // Загрузить фото последнего сданного отчёта
    const lastDone = resp.items.find(r => r.status === 'done')
    if (lastDone) {
      const detail = await apiStore.getReportById(lastDone.id)
      lastReportPhotos.value = detail.photos || []
      // Запустить загрузку превью для каждого фото
      for (const photo of lastReportPhotos.value) {
        void loadPhotoPreview(lastDone.id, photo.photoCode)
      }
    } else {
      lastReportPhotos.value = []
    }
  } catch (e) { error.value = e instanceof Error ? e.message : 'Ошибка' }
  finally { loading.value = false }
}

const mini = computed(() => {
  const total = reportHistory.value.length
  const done = reportHistory.value.filter(r => r.status === 'done').length
  const late = reportHistory.value.filter(r => r.status === 'expired' || (r.status === 'done' && r.deadlineAt && r.updatedAt && new Date(r.updatedAt) > new Date(r.deadlineAt))).length
  const onTime = done - reportHistory.value.filter(r => r.status === 'done' && r.deadlineAt && r.updatedAt && new Date(r.updatedAt) > new Date(r.deadlineAt)).length
  const pct = total ? Math.round(onTime / total * 100) : 0
  const avgMs = reportHistory.value
    .filter(r => r.status === 'done' && r.scheduledAt && r.updatedAt)
    .map(r => new Date(r.updatedAt!).getTime() - new Date(r.scheduledAt!).getTime())
  const avg = avgMs.length ? Math.round(avgMs.reduce((a, b) => a + b, 0) / avgMs.length / 60000) : null
  return { total, done, onTime, late, pct, avg }
})

const fmtTime = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('HH:mm') : '—'
const fmtDate = (iso: string | null) => iso ? DateTime.fromISO(iso).toFormat('dd.MM') : '—'
const fmtDow  = (iso: string | null) => iso ? ['вс','пн','вт','ср','чт','пт','сб'][new Date(iso).getDay()] : ''

const GRAD: Record<string, string> = {
  default: 'linear-gradient(135deg,#6a8caf,#34506b)',
  hall:    'linear-gradient(135deg,#6a8caf,#34506b)',
  wc:      'linear-gradient(135deg,#56b3a6,#2c7a6f)',
  cash:    'linear-gradient(135deg,#c9a24b,#8a6d22)',
  trk:     'linear-gradient(135deg,#c2705b,#8a3f2e)',
  area:    'linear-gradient(135deg,#7d9b5a,#4c6a31)',
}

const loadAzsOptions = async () => {
  if (azsOptionsLoading.value) return
  azsOptionsLoading.value = true
  try {
    const resp = await apiStore.getAzsOptions({ limit: 500 })
    azsOptions.value = resp.items.map(i => ({ value: String(i.id), label: i.title || `АЗС ${i.id}` }))
    azsOptionsError.value = false
    if (azsOptions.value.length && !selectedAzsId.value) {
      selectedAzsId.value = azsOptions.value[0].value
      await load()
    }
  } catch {
    azsOptionsError.value = true
  } finally {
    azsOptionsLoading.value = false
  }
}

onMounted(loadAzsOptions)
watch(selectedAzsId, load)
</script>

<template>
  <div>
    <div class="flex items-end justify-between gap-4 mb-4 flex-wrap">
      <div>
        <h1 class="text-[21px] font-semibold">Карточка АЗС</h1>
        <p class="text-sm text-gray-500 mt-0.5">Полный таймлайн прохождения и фото-доказательства</p>
      </div>
      <span class="text-[11.5px] text-gray-400 bg-white border border-gray-200 px-2 py-1 rounded-full">источник: dispatch_log + report_photo</span>
    </div>

    <!-- AZS picker -->
    <div class="flex gap-2.5 mb-4 flex-wrap items-center">
      <div class="flex flex-col gap-1">
        <B24InputMenu
          v-model="selectedAzsId"
          :items="azsOptions"
          value-attribute="value"
          option-attribute="label"
          placeholder="Выберите АЗС…"
          class="min-w-[260px]"
        />
        <div v-if="azsOptionsError" class="flex items-center gap-1.5 text-[12px] text-red-600">
          <span>Список АЗС не загрузился</span>
          <button class="underline hover:no-underline disabled:opacity-50" :disabled="azsOptionsLoading" @click="loadAzsOptions">Повторить</button>
        </div>
      </div>
      <span class="text-[12px] text-gray-400">за 30 дней</span>
    </div>

    <div v-if="loading" class="text-center py-8 text-gray-400">Загрузка…</div>
    <B24Alert v-else-if="error" color="air-primary-alert" :description="error" />
    <template v-else-if="selectedAzsId">
      <!-- Mini KPIs -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3.5">
        <div v-for="kpi in ([
          { t: '% вовремя (30д)', v: mini.pct + '%',                  c: mini.pct >= 90 ? '#1fa363' : mini.pct >= 75 ? '#e0a020' : '#e0533b' },
          { t: 'Среднее время',   v: mini.avg !== null ? mini.avg + ' мин' : '—', c: '#0f2742' },
          { t: 'Просрочек',       v: mini.late,                       c: mini.late ? '#e0533b' : '#1fa363' },
          { t: 'Сдач всего',      v: mini.done + '/' + mini.total,    c: '#0f2742' },
        ])" :key="kpi.t"
          class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-3.5"
        >
          <div class="text-[11.5px] text-gray-400 font-semibold">{{ kpi.t }}</div>
          <div class="text-[23px] font-extrabold mt-0.5" :style="`color:${kpi.c}`">{{ kpi.v }}</div>
        </div>
      </div>

      <!-- Последний отчёт: фото -->
      <div v-if="lastDoneReport" class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4 mb-3.5">
        <h3 class="font-semibold mb-3">
          Последний отчёт · {{ fmtDate(lastDoneReport.scheduledAt) }}, уведомление {{ fmtTime(lastDoneReport.scheduledAt) }}, сдано {{ fmtTime(lastDoneReport.updatedAt) }}
        </h3>
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div v-for="photo in lastReportPhotos" :key="photo.photoCode"
            class="relative rounded-[11px] aspect-[4/3] overflow-hidden border border-black/5 flex items-end text-white"
            :style="`background:${GRAD[photo.photoCode] || GRAD.default}`"
          >
            <img
              v-if="previewUrls.get(getPreviewKey(lastDoneReport.id, photo.photoCode))"
              :src="previewUrls.get(getPreviewKey(lastDoneReport.id, photo.photoCode))!"
              class="absolute inset-0 w-full h-full object-cover"
              loading="lazy"
              :alt="photo.photoCode"
              @error="($event.target as HTMLImageElement).style.display='none'"
            />
            <div v-if="photo.exifAt" class="absolute top-2 right-2 bg-black/45 backdrop-blur-sm text-[10.5px] px-1.5 py-0.5 rounded-full font-bold">
              📷 {{ fmtTime(photo.exifAt) }}
            </div>
            <div class="relative z-10 px-2.5 py-2 w-full bg-gradient-to-t from-black/45 to-transparent text-[12px] font-semibold">
              {{ photo.photoCode }}
            </div>
          </div>
        </div>
        <p class="text-[12px] text-gray-400 mt-2.5">Время в углу — момент съёмки (exif_at). Фото делается только живой камерой — доказательство «снято на месте».</p>
      </div>

      <!-- Timeline -->
      <div class="bg-white border border-gray-200 rounded-[14px] shadow-sm p-4">
        <h3 class="font-semibold mb-3">История прохождений</h3>
        <div>
          <div v-for="(rep, idx) in reportHistory" :key="rep.id"
            :class="['grid gap-3.5 py-3', idx < reportHistory.length - 1 ? 'border-b border-gray-100' : '']"
            style="grid-template-columns:88px 1fr"
          >
            <div>
              <div class="font-bold text-[13px]">{{ fmtDate(rep.scheduledAt) }}</div>
              <div class="text-[11.5px] text-gray-400">{{ fmtDow(rep.scheduledAt) }}</div>
            </div>
            <div class="flex items-center gap-2 flex-wrap text-[12.5px]">
              <span class="bg-gray-100 rounded-lg px-2 py-1 font-semibold text-[#46586c]">уведомление {{ fmtTime(rep.scheduledAt) }}</span>
              <span class="text-gray-300">→</span>
              <template v-if="rep.updatedAt && rep.status === 'done'">
                <span :class="['bg-gray-100 rounded-lg px-2 py-1 font-semibold', rep.deadlineAt && new Date(rep.updatedAt) <= new Date(rep.deadlineAt) ? 'bg-green-50 text-green-700' : 'text-[#46586c]']">
                  сдано {{ fmtTime(rep.updatedAt) }}
                </span>
              </template>
              <template v-else>
                <span class="bg-red-50 text-red-600 rounded-lg px-2 py-1 font-semibold">не сдано</span>
              </template>
              <span class="ml-auto">
                <B24Badge :color="rep.status === 'done' ? 'air-primary-success' : rep.status === 'expired' ? 'air-primary-alert' : 'air-secondary'">
                  {{ rep.status === 'done' ? 'вовремя' : rep.status === 'expired' ? 'просрочено' : rep.status }}
                </B24Badge>
              </span>
            </div>
          </div>
          <div v-if="!reportHistory.length" class="text-center py-6 text-gray-400">Нет истории за 30 дней</div>
        </div>
      </div>
    </template>
  </div>
</template>
