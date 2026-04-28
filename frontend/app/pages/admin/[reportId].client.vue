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

const photoSlots = reactive<SlotState[]>([
  { key: 'totem', title: 'Тотем / цена стелы', done: false, fileName: '', error: '' },
  { key: 'columns', title: 'Топливораздаточные колонки', done: false, fileName: '', error: '' },
  { key: 'shop', title: 'Торговый зал / касса', done: false, fileName: '', error: '' },
  { key: 'territory', title: 'Территория АЗС', done: false, fileName: '', error: '' }
])

const completedCount = computed(() => photoSlots.filter((slot) => slot.done).length)
const allCompleted = computed(() => completedCount.value === photoSlots.length)

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
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Не удалось загрузить отчёт'
  } finally {
    isLoading.value = false
  }
}

const onPickFile = (event: Event, slot: SlotState) => {
  slot.error = ''
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    slot.done = false
    slot.fileName = ''
    return
  }

  if (file.size > 10 * 1024 * 1024) {
    slot.done = false
    slot.fileName = ''
    slot.error = 'Файл больше 10 МБ'
    return
  }

  slot.done = true
  slot.fileName = file.name
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
        description="Это рабочий экран мобильного сбора фото. Серверная загрузка в Диск и перевод в DONE будут добавлены в Sprint 6."
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
      v-for="slot in photoSlots"
      :key="slot.key"
      variant="outline"
    >
      <template #header>
        <div class="flex items-center justify-between">
          <ProseH3>{{ slot.title }}</ProseH3>
          <B24Badge :color="slot.done ? 'air-primary-success' : 'air-secondary'">
            {{ slot.done ? 'загружено' : 'ожидает фото' }}
          </B24Badge>
        </div>
      </template>

      <div class="space-y-2">
        <input
          class="block w-full text-sm"
          type="file"
          accept="image/*"
          capture="environment"
          @change="(event) => onPickFile(event, slot)"
        >
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
