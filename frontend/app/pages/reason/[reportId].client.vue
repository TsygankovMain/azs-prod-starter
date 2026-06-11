<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

type ReasonItem = { code: string; label: string }

const PAGE_TITLE = 'Причина просрочки'
useHead({ title: PAGE_TITLE })

const { initApp, b24Helper, destroyB24Helper, processErrorGlobal } = useAppInit('ReasonPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const route = useRoute()
const { errorText, errorDetail } = useErrorText()

// reportId берётся из URL — НЕ хардкодим
const reportId = computed(() => Number(route.params.reportId))

type ReportData = {
  id: number
  azsTitle?: string
  status: string
  deadlineAt?: string | null
}

const isLoading = ref(false)
const isSaving = ref(false)
const isSubmitted = ref(false)
const loadError = ref('')
const loadErrorDetail = ref('')
const saveError = ref('')
const saveErrorDetail = ref('')
const report = ref<ReportData | null>(null)
// Список причин из настроек (не хардкод)
const reasons = ref<ReasonItem[]>([])
const selectedCode = ref('')
const otherText = ref('')

// Вычислить: выбрано ли «Другое» — требует текст
const isOtherSelected = computed(() =>
  selectedCode.value === 'other'
)

// Автофокус поля «Другое» при выборе варианта
const otherInputRef = ref<{ $el?: HTMLElement; focus?: () => void } | null>(null)
// фокус только по действию пользователя; предзаполнение selectedCode='other' из API не предусмотрено — если появится, пересмотреть, чтобы клавиатура не открывалась сама
watch(isOtherSelected, async (value) => {
  if (value) {
    await nextTick()
    const el = otherInputRef.value
    if (el) {
      if (typeof el.focus === 'function') {
        el.focus()
        ;(el.$el ?? el).scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      } else if (el.$el) {
        const textarea = el.$el.querySelector('textarea') as HTMLTextAreaElement | null
        textarea?.focus()
        ;(el.$el ?? el).scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      }
    }
  }
})

const canSubmit = computed(() =>
  Boolean(selectedCode.value)
  && (!isOtherSelected.value || otherText.value.trim().length > 0)
  && !isSaving.value
  && !isSubmitted.value
)

async function loadData() {
  isLoading.value = true
  loadError.value = ''
  try {
    const [reportResponse, settingsResponse] = await Promise.all([
      apiStore.getReportById(reportId.value),
      apiStore.getSettings()
    ])
    report.value = {
      id: reportResponse.item.id,
      azsTitle: (reportResponse.item as { azsTitle?: string }).azsTitle ?? `АЗС ${reportResponse.item.azsId}`,
      status: reportResponse.item.status,
      deadlineAt: reportResponse.item.deadlineAt
    }
    // Список причин из настроек — никакого хардкода
    const rawSettings = settingsResponse.settings as Record<string, unknown>
    const reportSettings = rawSettings?.report as Record<string, unknown> | undefined
    reasons.value = Array.isArray(reportSettings?.reasons)
      ? (reportSettings.reasons as ReasonItem[]).filter(r => r?.code && r?.label)
      : []
  } catch (error) {
    loadError.value = errorText(error)
    loadErrorDetail.value = errorDetail(error)
  } finally {
    isLoading.value = false
  }
}

async function submitReason() {
  if (!canSubmit.value) return
  isSaving.value = true
  saveError.value = ''
  saveErrorDetail.value = ''
  try {
    await apiStore.submitReason(reportId.value, {
      reasonCode: selectedCode.value,
      reasonText: isOtherSelected.value ? otherText.value.trim() : null
    })
    isSubmitted.value = true
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status
    if (status === 403) {
      saveError.value = 'Нет доступа: вы не являетесь исполнителем или проверяющим этого отчёта.'
      saveErrorDetail.value = errorDetail(error)
    } else {
      saveError.value = errorText(error, 'Не удалось сохранить причину')
      saveErrorDetail.value = errorDetail(error)
    }
  } finally {
    isSaving.value = false
  }
}

onMounted(async () => {
  try {
    isLoading.value = true
    const $b24 = await $initializeB24Frame()
    await initApp($b24, [], () => {})
    await $b24.parent.setTitle(PAGE_TITLE)
    await loadData()
  } catch (error) {
    processErrorGlobal(error)
  } finally {
    isLoading.value = false
  }
})

onUnmounted(() => {
  if (b24Helper.value) destroyB24Helper()
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-[600px] flex-col gap-4 p-4 pb-16">

    <!-- Заголовок -->
    <div>
      <ProseH2 class="mb-1">Причина просрочки</ProseH2>
      <ProseP v-if="report" class="mb-0 text-sm text-(--ui-color-base-70)">
        АЗС: {{ report.azsTitle }}
      </ProseP>
    </div>

    <!-- Ошибка загрузки -->
    <div v-if="loadError" class="space-y-1">
      <B24Alert
        color="air-primary-alert"
        title="Не удалось загрузить данные"
        :description="loadError"
      />
      <details v-if="loadErrorDetail" class="list-none text-xs text-gray-400">
        <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
        <p class="mt-1 font-mono break-all">{{ loadErrorDetail }}</p>
      </details>
    </div>

    <!-- Загрузка -->
    <div v-if="isLoading" class="text-center py-8 text-gray-400">Загрузка…</div>

    <!-- Успешно отправлено -->
    <B24Alert
      v-else-if="isSubmitted"
      color="air-primary-success"
      title="Причина сохранена"
      description="Спасибо, причина записана. Можно закрыть страницу."
    />

    <!-- Форма выбора причины -->
    <template v-else-if="!isLoading && reasons.length > 0">
      <div class="space-y-3">
        <ProseP class="mb-0 text-sm font-medium">Выберите причину:</ProseP>

        <!-- Кнопки-пресеты из настроек (не хардкод) -->
        <div class="grid grid-cols-2 gap-2">
          <button
            v-for="reason in reasons"
            :key="reason.code"
            type="button"
            class="min-h-12 rounded-lg border px-3 py-2 text-left text-sm leading-tight transition-colors"
            :class="selectedCode === reason.code
              ? 'border-(--ui-color-primary) bg-(--ui-color-primary) text-white'
              : 'border-(--ui-color-base-30) bg-(--ui-color-base-0) hover:bg-(--ui-color-base-10)'"
            :aria-pressed="selectedCode === reason.code"
            @click="selectedCode = reason.code"
          >
            {{ reason.label }}
          </button>
        </div>

        <!-- Поле для «Другое» — показывается только если выбран other, обязательно для отправки -->
        <div v-if="isOtherSelected" class="space-y-1">
          <label class="block text-sm font-medium">Опишите причину <span class="text-(--ui-color-primary-alert)">*</span></label>
          <B24Textarea
            ref="otherInputRef"
            v-model="otherText"
            class="w-full"
            placeholder="Укажите причину..."
            :rows="3"
          />
          <ProseP v-if="!otherText.trim()" class="mb-0 text-xs text-(--ui-color-primary-alert)">
            Для причины «Другое» необходимо заполнить текст
          </ProseP>
        </div>
      </div>

      <!-- Ошибка сохранения -->
      <div v-if="saveError" class="space-y-1">
        <B24Alert
          color="air-primary-alert"
          title="Ошибка"
          :description="saveError"
        />
        <details v-if="saveErrorDetail" class="list-none text-xs text-gray-400">
          <summary class="list-none [&::-webkit-details-marker]:hidden cursor-pointer hover:text-gray-600 select-none">Подробности</summary>
          <p class="mt-1 font-mono break-all">{{ saveErrorDetail }}</p>
        </details>
      </div>

      <!-- Кнопка отправки — закреплена снизу -->
      <div class="sticky bottom-0 -mx-4 border-t border-(--ui-color-base-20) bg-(--ui-color-base-0)/95 p-3 backdrop-blur-sm">
        <B24Button
          color="air-tertiary"
          label="Сохранить причину"
          :disabled="!canSubmit"
          :loading="isSaving"
          loading-auto
          class="w-full"
          @click="submitReason"
        />
      </div>
    </template>

    <!-- Нет настроенных причин -->
    <B24Alert
      v-else-if="!isLoading && !loadError && reasons.length === 0"
      color="air-secondary"
      title="Список причин не настроен"
      description="Администратор не настроил список причин. Обратитесь к системному администратору."
    />

  </div>
</template>
