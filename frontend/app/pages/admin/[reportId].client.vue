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
  confirmed: boolean
  uploaded: boolean
  uploading: boolean
  previewUrl: string
  file: File | null
  fileName: string
  error: string
}

type RequiredPhoto = {
  code: string
  title: string
  sort?: number
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
const isSubmitting = ref(false)
const submitError = ref('')

const photoSlots = reactive<SlotState[]>([])

const confirmedCount = computed(() => photoSlots.filter((slot) => slot.confirmed).length)
const uploadedCount = computed(() => photoSlots.filter((slot) => slot.uploaded).length)
const allConfirmed = computed(() => photoSlots.length > 0 && confirmedCount.value === photoSlots.length)
const allUploaded = computed(() => photoSlots.length > 0 && uploadedCount.value === photoSlots.length)
const hasUploading = computed(() => photoSlots.some((slot) => slot.uploading))
const hasUploadErrors = computed(() => photoSlots.some((slot) => Boolean(slot.error) && slot.confirmed && !slot.uploaded))
const currentSlotIndex = computed(() => {
  const index = photoSlots.findIndex((slot) => !slot.confirmed)
  return index >= 0 ? index : photoSlots.length
})
const canSubmitReport = computed(() => (
  allConfirmed.value
  && allUploaded.value
  && !hasUploading.value
  && !hasUploadErrors.value
  && !isSubmitting.value
  && report.value?.status !== 'done'
))
const isCameraOpen = computed(() => Boolean(activeCameraSlotKey.value))

const makeSlot = (photo: RequiredPhoto): SlotState => ({
  key: String(photo.code || '').trim().toLowerCase(),
  title: String(photo.title || photo.code || '').trim(),
  confirmed: false,
  uploaded: false,
  uploading: false,
  previewUrl: '',
  file: null,
  fileName: '',
  error: ''
})

const revokeSlotPreview = (slot: SlotState) => {
  if (slot.previewUrl) {
    URL.revokeObjectURL(slot.previewUrl)
    slot.previewUrl = ''
  }
}

const applyRequiredPhotos = (requiredPhotos: RequiredPhoto[] = []) => {
  for (const slot of photoSlots) {
    revokeSlotPreview(slot)
  }
  const nextSlots = requiredPhotos
    .map(makeSlot)
    .filter((slot) => slot.key)

  photoSlots.splice(0, photoSlots.length, ...nextSlots)
}

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

const setCameraVideoRef = (el: Element | null) => {
  cameraVideoEl.value = el instanceof HTMLVideoElement ? el : null
}

const safePlayVideo = async (videoEl: HTMLVideoElement | null) => {
  if (!videoEl) {
    return
  }
  const playFn = (videoEl as HTMLVideoElement & { play?: () => Promise<void> | void }).play
  if (typeof playFn !== 'function') {
    throw new Error('Видео-элемент не поддерживает воспроизведение')
  }
  await Promise.resolve(playFn.call(videoEl))
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
      await safePlayVideo(cameraVideoEl.value).catch(() => undefined)
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
    applyRequiredPhotos(response.requiredPhotos || [])
    const uploaded = new Set((response.photos || []).map((photo) => String(photo.photoCode || '').toLowerCase()))
    for (const slot of photoSlots) {
      const isUploaded = uploaded.has(slot.key)
      slot.confirmed = isUploaded
      slot.uploaded = isUploaded
      if (!slot.uploaded) {
        slot.fileName = ''
      }
      slot.error = ''
      slot.uploading = false
    }
  } catch (error) {
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
      }
    })?.data
    loadError.value = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось загрузить отчёт')
  } finally {
    isLoading.value = false
  }
}

const uploadSlotFile = async (slot: SlotState, file: File) => {
  saveError.value = ''
  saveSuccess.value = ''
  slot.error = ''

  if (file.size > 10 * 1024 * 1024) {
    slot.uploaded = false
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
    slot.uploaded = true
    slot.fileName = file.name
    const status = String((response.item as Record<string, unknown>).status || '')
    if (status === 'in_progress') {
      saveSuccess.value = 'Фото загружено в фоне.'
    }
  } catch (error) {
    slot.uploaded = false
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
        currentUserId?: number
        expectedAdminUserId?: number
      }
    })?.data
    const accessDetails = responseData?.error === 'forbidden_user'
      ? ` Текущий пользователь: ${String(responseData.currentUserId || '—')}, назначенный админ отчёта: ${String(responseData.expectedAdminUserId || '—')}.`
      : ''
    const responseMessage = responseData?.message || responseData?.error
    slot.error = `${responseMessage || (error instanceof Error ? error.message : 'Не удалось загрузить фото')}${accessDetails}`
    saveError.value = slot.error
  } finally {
    slot.uploading = false
  }
}

const captureSlotPreview = async (slot: SlotState) => {
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
  revokeSlotPreview(slot)
  slot.file = file
  slot.previewUrl = URL.createObjectURL(file)
  slot.confirmed = false
  slot.uploaded = false
  slot.fileName = file.name
  closeCamera()
}

const acceptSlotPhoto = (slot: SlotState) => {
  if (!slot.file) {
    slot.error = 'Сначала сделайте фото'
    return
  }

  slot.confirmed = true
  slot.uploaded = false
  slot.error = ''
  void uploadSlotFile(slot, slot.file)
}

const retakeSlotPhoto = async (slot: SlotState) => {
  revokeSlotPreview(slot)
  slot.file = null
  slot.confirmed = false
  slot.uploaded = false
  slot.fileName = ''
  slot.error = ''
  await startCameraForSlot(slot)
}

const retrySlotUpload = (slot: SlotState) => {
  if (!slot.file) {
    slot.error = 'Локальный файл недоступен, переснимите фото'
    return
  }
  slot.error = ''
  void uploadSlotFile(slot, slot.file)
}

const submitReport = async () => {
  if (!canSubmitReport.value) {
    return
  }

  const id = Number(route.params.reportId)
  if (!Number.isFinite(id) || id <= 0) {
    submitError.value = 'Некорректный reportId'
    return
  }

  isSubmitting.value = true
  submitError.value = ''
  saveSuccess.value = ''
  try {
    await apiStore.submitReport(id)
    saveSuccess.value = 'Отчёт отправлен. Статус переведён в DONE.'
    await loadReport()
  } catch (error) {
    const responseData = (error as {
      data?: {
        message?: string
        error?: string
      }
    })?.data
    submitError.value = responseData?.message || responseData?.error || (error instanceof Error ? error.message : 'Не удалось отправить отчёт')
  } finally {
    isSubmitting.value = false
  }
}

const leaveReport = async () => {
  closeCamera()
  await navigateTo('/')
}

const openSettings = async () => {
  closeCamera()
  await navigateTo('/settings')
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
  for (const slot of photoSlots) {
    revokeSlotPreview(slot)
  }
})
</script>

<template>
  <div class="w-full max-w-[920px] mx-auto px-4 py-4 space-y-4">
    <B24Card>
      <template #header>
        <div class="flex items-center justify-between">
          <div class="space-y-2">
            <ProseH2>Экран Администратора АЗС</ProseH2>
            <div class="flex flex-wrap items-center gap-2">
              <B24Button
                color="air-secondary"
                variant="outline"
                label="Выйти из отчёта"
                @click="leaveReport"
              />
              <B24Button
                color="air-primary"
                variant="solid"
                label="В настройки"
                @click="openSettings"
              />
            </div>
          </div>
          <B24Badge :color="allUploaded ? 'air-primary-success' : 'air-secondary'">
            {{ uploadedCount }}/{{ photoSlots.length }} загружено
          </B24Badge>
        </div>
      </template>

      <B24Alert
        color="air-secondary"
        title="Пошаговый сбор фото"
        description="Сделайте фото, проверьте кадр, подтвердите его. После подтверждения фото загрузится в фоне."
      />
    </B24Card>

    <B24Alert
      v-if="loadError"
      color="air-primary-alert"
      title="Ошибка загрузки отчёта"
      :description="loadError"
    />
    <B24Alert
      v-if="!isLoading && !loadError && photoSlots.length === 0"
      color="air-primary-alert"
      title="Нет обязательных фото"
      description="Для этого отчёта не определён набор обязательных фото. Проверьте настройки и карточку АЗС."
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
    <B24Alert
      v-if="submitError"
      color="air-primary-alert"
      title="Ошибка отправки отчёта"
      :description="submitError"
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

    <B24Card
      v-for="(slot, index) in photoSlots"
      :key="slot.key"
      variant="outline"
      :class="index > currentSlotIndex ? 'opacity-60' : ''"
    >
      <template #header>
        <div class="flex items-center justify-between">
          <div>
            <ProseH3>{{ index + 1 }}. {{ slot.title }}</ProseH3>
            <ProseP v-if="index > currentSlotIndex" class="mb-0 text-[13px] text-gray-500">
              Откроется после предыдущего фото
            </ProseP>
          </div>
          <B24Badge :color="slot.uploaded ? 'air-primary-success' : (slot.error ? 'air-primary-alert' : 'air-secondary')">
            {{ slot.uploading ? 'загрузка...' : (slot.uploaded ? 'загружено' : (slot.confirmed ? 'ожидает загрузки' : 'ожидает фото')) }}
          </B24Badge>
        </div>
      </template>

      <div class="space-y-2">
        <div
          v-if="slot.previewUrl"
          class="rounded overflow-hidden bg-black"
        >
          <img
            :src="slot.previewUrl"
            :alt="slot.title"
            class="w-full max-h-[420px] object-contain"
          >
        </div>

        <div class="flex flex-wrap gap-2">
          <B24Button
            v-if="index <= currentSlotIndex && !slot.previewUrl && !slot.confirmed"
            color="air-primary"
            :label="activeCameraSlotKey === slot.key ? 'Камера активна' : 'Открыть камеру'"
            :disabled="slot.uploading || cameraBusy || index > currentSlotIndex"
            loading-auto
            @click="startCameraForSlot(slot)"
          />
          <B24Button
            v-if="activeCameraSlotKey === slot.key"
            color="air-primary-success"
            label="Сделать фото"
            :disabled="slot.uploading"
            loading-auto
            @click="captureSlotPreview(slot)"
          />
          <B24Button
            v-if="activeCameraSlotKey === slot.key"
            color="air-secondary"
            label="Закрыть камеру"
            :disabled="slot.uploading"
            loading-auto
            @click="closeCamera"
          />
          <B24Button
            v-if="slot.previewUrl && !slot.confirmed"
            color="air-primary-success"
            label="Использовать фото"
            :disabled="slot.uploading"
            loading-auto
            @click="acceptSlotPhoto(slot)"
          />
          <B24Button
            v-if="slot.previewUrl && !slot.uploaded"
            color="air-secondary"
            label="Переснять"
            :disabled="slot.uploading || cameraBusy"
            loading-auto
            @click="retakeSlotPhoto(slot)"
          />
          <B24Button
            v-if="slot.error && slot.confirmed && !slot.uploaded"
            color="air-primary"
            label="Повторить загрузку"
            :disabled="slot.uploading"
            loading-auto
            @click="retrySlotUpload(slot)"
          />
        </div>
        <div v-if="activeCameraSlotKey === slot.key" class="rounded overflow-hidden bg-black">
          <video
            :ref="setCameraVideoRef"
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

    <B24Card v-if="photoSlots.length > 0" variant="outline">
      <template #header>
        <div class="flex items-center justify-between gap-3">
          <div>
            <ProseH3>Отправка отчёта</ProseH3>
            <ProseP class="mb-0 text-[13px] text-gray-500">
              Отчёт можно отправить после подтверждения и фоновой загрузки всех фото.
            </ProseP>
          </div>
          <B24Badge :color="canSubmitReport ? 'air-primary-success' : 'air-secondary'">
            {{ confirmedCount }}/{{ photoSlots.length }} подтверждено
          </B24Badge>
        </div>
      </template>

      <div class="flex flex-wrap items-center gap-2">
        <B24Button
          color="air-primary-success"
          label="Отправить отчёт"
          :disabled="!canSubmitReport"
          loading-auto
          @click="submitReport"
        />
        <B24Badge v-if="hasUploading" color="air-secondary">
          идёт фоновая загрузка
        </B24Badge>
        <B24Badge v-if="hasUploadErrors" color="air-primary-alert">
          есть ошибки загрузки
        </B24Badge>
        <B24Badge v-if="report?.status === 'done'" color="air-primary-success">
          отчёт отправлен
        </B24Badge>
      </div>
    </B24Card>
  </div>
</template>
