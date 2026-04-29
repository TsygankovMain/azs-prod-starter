<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

type ReportRow = {
  id: number
  slotKey: string
  azsId: string
  adminUserId: number
  status: string
  reportItemId: number | null
  deadlineAt: string | null
}

type SlotState = {
  key: string
  title: string
  done: boolean
  uploading: boolean
  fileName: string
  error: string
}

const PAGE_TITLE = 'Фотоотчёт АЗС: загрузка'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('AdminReportPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const route = useRoute()

let $b24: null | B24Frame = null

const isLoading = ref(false)
const loadError = ref('')
const report = ref<ReportRow | null>(null)
const saveError = ref('')
const saveSuccess = ref('')
const activeCameraSlotKey = ref('')
const cameraError = ref('')
const cameraBusy = ref(false)
const cameraVideoEl = ref<HTMLVideoElement | null>(null)
const cameraStream = ref<MediaStream | null>(null)

const photoSlots = reactive<SlotState[]>([
  { key: 'totem', title: 'Тотем / цена стелы', done: false, uploading: false, fileName: '', error: '' },
  { key: 'columns', title: 'Топливораздаточные колонки', done: false, uploading: false, fileName: '', error: '' },
  { key: 'shop', title: 'Торговый зал / касса', done: false, uploading: false, fileName: '', error: '' },
  { key: 'territory', title: 'Территория АЗС', done: false, uploading: false, fileName: '', error: '' }
])

const completedCount = computed(() => photoSlots.filter((slot) => slot.done).length)
const allCompleted = computed(() => completedCount.value === photoSlots.length)
const isCameraOpen = computed(() => Boolean(activeCameraSlotKey.value))

const stopCameraStream = () => {
  if (cameraVideoEl.value) {
    cameraVideoEl.value.srcObject = null
  }
  if (cameraStream.value) {
    for (const track of cameraStream.value.getTracks()) {
      track.stop()
    }
    cameraStream.value = null
  }
}

const closeCamera = () => {
  activeCameraSlotKey.value = ''
  cameraError.value = ''
  stopCameraStream()
}

const startCameraForSlot = async (slot: SlotState) => {
  slot.error = ''
  saveError.value = ''
  saveSuccess.value = ''
  cameraError.value = ''
  cameraBusy.value = true

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Камера недоступна в этом WebView')
    }

    stopCameraStream()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' }
      }
    })

    cameraStream.value = stream
    activeCameraSlotKey.value = slot.key
    await nextTick()
    if (cameraVideoEl.value) {
      cameraVideoEl.value.srcObject = stream
      await cameraVideoEl.value.play().catch(() => undefined)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось открыть камеру'
    cameraError.value = message
    slot.error = message
    closeCamera()
  } finally {
    cameraBusy.value = false
  }
}

const loadReport = async () => {
  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    loadError.value = 'Некорректный reportId в URL'
    return
  }

  isLoading.value = true
  loadError.value = ''
  try {
    const response = await apiStore.getReportById(id)
    report.value = response.item as ReportRow
    const uploaded = new Set((response.photos || []).map((photo) => String(photo.photoCode || '').toLowerCase()))
    for (const slot of photoSlots) {
      slot.done = uploaded.has(slot.key)
      if (!slot.done) {
        slot.fileName = ''
      }
      slot.error = ''
      slot.uploading = false
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Не удалось загрузить отчёт'
  } finally {
    isLoading.value = false
  }
}

const uploadSlotFile = async (slot: SlotState, file: File) => {
  saveError.value = ''
  saveSuccess.value = ''
  slot.error = ''

  if (file.size > 10 * 1024 * 1024) {
    slot.done = false
    slot.fileName = ''
    slot.error = 'Файл больше 10 МБ'
    return
  }

  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    slot.error = 'Некорректный reportId'
    return
  }

  slot.uploading = true
  try {
    const response = await apiStore.uploadReportPhoto({
      reportId: id,
      photoCode: slot.key,
      file
    })
    slot.done = true
    slot.fileName = file.name
    const status = String((response.item as Record<string, unknown>).status || '')
    if (status === 'done') {
      saveSuccess.value = 'Все обязательные фото загружены. Отчёт переведён в DONE.'
    }
    await loadReport()
  } catch (error) {
    slot.done = false
    slot.fileName = ''
    slot.error = error instanceof Error ? error.message : 'Не удалось загрузить фото'
    saveError.value = slot.error
  } finally {
    slot.uploading = false
  }
}

const captureAndUpload = async (slot: SlotState) => {
  slot.error = ''
  cameraError.value = ''

  const video = cameraVideoEl.value
  if (!video || !cameraStream.value) {
    const message = 'Камера не инициализирована'
    slot.error = message
    cameraError.value = message
    return
  }

  const width = video.videoWidth || 1280
  const height = video.videoHeight || 720
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) {
    const message = 'Не удалось подготовить кадр камеры'
    slot.error = message
    cameraError.value = message
    return
  }

  ctx.drawImage(video, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.92)
  })
  if (!blob) {
    const message = 'Не удалось получить фото из камеры'
    slot.error = message
    cameraError.value = message
    return
  }

  const file = new File([blob], `${slot.key}_${Date.now()}.jpg`, { type: 'image/jpeg' })
  await uploadSlotFile(slot, file)
  if (slot.done) {
    closeCamera()
  }
}

onMounted(async () => {
  try {
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadReport()
  } catch (error) {
    processErrorGlobal(error)
  }
})

onBeforeUnmount(() => {
  closeCamera()
})
</script>

<template>
  <div class="w-full max-w-[920px] mx-auto px-4 py-4 space-y-4">
    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH2>Экран Администратора АЗС</ProseH2>
          <B24Badge :color="allCompleted ? 'air-primary-success' : 'air-secondary'">
            {{ completedCount }}/{{ photoSlots.length }} загружено
          </B24Badge>
        </div>
      </template>

      <B24Alert
        color="air-secondary"
        title="Шаг Sprint 5"
        description="Экран мобильного сбора фото. Фото отправляются в backend endpoint /api/reports/:id/photo."
      />
    </B24Card>

    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Ошибка загрузки отчёта"
      :description="loadError"
    />
    <B24Alert
      v-if="isLoading"
      color="air-secondary"
      title="Загрузка"
      description="Загружаем карточку отчёта..."
    />
    <B24Alert
      v-if="saveSuccess"
      color="air-primary-success"
      title="Успешно"
      :description="saveSuccess"
    />
    <B24Alert
      v-if="saveError"
      color="air-primary-alert"
      title="Ошибка загрузки"
      :description="saveError"
    />

    <B24Card v-if="report">
      <template #header>
        <ProseH3>Отчёт #{{ report.id }}</ProseH3>
      </template>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        <B24Badge color="air-secondary">АЗС: {{ report.azsId }}</B24Badge>
        <B24Badge color="air-secondary">Слот: {{ report.slotKey }}</B24Badge>
        <B24Badge color="air-secondary">Статус: {{ report.status }}</B24Badge>
        <B24Badge color="air-secondary">Дедлайн: {{ report.deadlineAt || '—' }}</B24Badge>
      </div>
    </B24Card>

    <B24Card v-for="slot in photoSlots" :key="slot.key" variant="outline">
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH3>{{ slot.title }}</ProseH3>
          <B24Badge :color="slot.done ? 'air-primary-success' : 'air-secondary'">
            {{ slot.uploading ? 'загрузка...' : (slot.done ? 'загружено' : 'ожидает фото') }}
          </B24Badge>
        </div>
      </template>

      <div class="space-y-2">
        <div class="flex flex-wrap gap-2">
          <B24Button
            color="air-primary"
            :label="activeCameraSlotKey === slot.key ? 'Камера активна' : 'Открыть камеру'"
            :disabled="slot.uploading || cameraBusy"
            loading-auto
            @click="startCameraForSlot(slot)"
          />
          <B24Button
            v-if="activeCameraSlotKey === slot.key"
            color="air-primary-success"
            label="Сделать фото"
            :disabled="slot.uploading"
            loading-auto
            @click="captureAndUpload(slot)"
          />
          <B24Button
            v-if="activeCameraSlotKey === slot.key"
            color="air-secondary"
            label="Закрыть камеру"
            :disabled="slot.uploading"
            loading-auto
            @click="closeCamera"
          />
        </div>
        <div v-if="activeCameraSlotKey === slot.key" class="rounded overflow-hidden bg-black">
          <video
            ref="cameraVideoEl"
            class="w-full max-h-[420px] object-cover"
            autoplay
            playsinline
            muted
          />
        </div>
        <B24Alert
          v-if="isCameraOpen && activeCameraSlotKey === slot.key"
          color="air-secondary"
          title="Режим камеры"
          description="Фото берётся только с камеры, выбор файла из галереи отключен в интерфейсе приложения."
        />
        <B24Alert
          v-if="cameraError && activeCameraSlotKey === slot.key"
          color="air-primary-alert"
          title="Ошибка камеры"
          :description="cameraError"
        />
        <ProseP v-if="slot.fileName" class="text-[13px]">Файл: {{ slot.fileName }}</ProseP>
        <B24Alert
          v-if="slot.error"
          color="air-primary-alert"
          title="Ошибка файла"
          :description="slot.error"
        />
      </div>
    </B24Card>
  </div>
</template>
