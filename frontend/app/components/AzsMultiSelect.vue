<script setup lang="ts">
/**
 * AzsMultiSelect — переиспользуемый мультиселект АЗС с поиском.
 *
 * Стратегия загрузки данных:
 *  - По умолчанию компонент грузит список самостоятельно через getAzsOptions()
 *    (аналогично R1Summary.vue / PhotoFeedView.vue).
 *  - Если передан prop `options`, API-вызов пропускается — это позволяет
 *    родителю передать уже загруженный список и избежать дублирования запросов
 *    (актуально для страниц D1/E1, где несколько виджетов на одной странице).
 *
 * Паттерн чекбоксов взят из PhotoFilters.vue / RemarkJournal.vue как
 * установившийся стиль проекта (не B24InputMenu, т.к. тот не поддерживает
 * визуальный поиск с «Выбрать все» / «Снять»).
 */

export type AzsSelectOption = {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  /** Текущий массив id выбранных АЗС (v-model) */
  modelValue: string[]
  /**
   * Готовый список АЗС от родителя.
   * Если не передан — компонент загружает сам через getAzsOptions().
   */
  options?: AzsSelectOption[]
  /**
   * Id АЗС, доступных только для чтения / недоступных для выбора
   * (например, уже привязанных к другому бренду или профилю).
   * Они отображаются в списке с меткой «занята» и не кликабельны.
   */
  disabledAzsIds?: string[]
  /** Метка над виджетом */
  label?: string
  /** Текст-заглушка, когда ничего не выбрано */
  placeholder?: string
}>(), {
  options: undefined,
  disabledAzsIds: () => [],
  label: 'АЗС',
  placeholder: 'Все АЗС'
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[]): void
}>()

const apiStore = useApiStore()

// ── Список АЗС ────────────────────────────────────────────────────────────────
const internalOptions = ref<AzsSelectOption[]>([])
const isLoading = ref(false)
const loadError = ref(false)

/** Итоговый список: переданный пропом или загруженный самостоятельно */
const resolvedOptions = computed<AzsSelectOption[]>(() =>
  props.options ?? internalOptions.value
)

const loadOptions = async () => {
  if (props.options !== undefined) return  // данные пришли пропом — не дёргаем API
  if (isLoading.value) return
  isLoading.value = true
  loadError.value = false
  try {
    const resp = await apiStore.getAzsOptions({ limit: 500 })
    internalOptions.value = resp.items.map(i => ({
      value: String(i.id || '').trim(),
      label: String(i.title || `АЗС ${i.id}`).trim()
    }))
  } catch {
    loadError.value = true
  } finally {
    isLoading.value = false
  }
}

onMounted(loadOptions)

// ── Поиск ─────────────────────────────────────────────────────────────────────
const searchQuery = ref('')

const filteredOptions = computed<AzsSelectOption[]>(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return resolvedOptions.value
  return resolvedOptions.value.filter(o =>
    o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  )
})

// ── Выбор ─────────────────────────────────────────────────────────────────────
const isDisabled = (value: string) => props.disabledAzsIds.includes(value)

const toggle = (value: string) => {
  if (isDisabled(value)) return
  const next = [...props.modelValue]
  const idx = next.indexOf(value)
  if (idx === -1) next.push(value)
  else next.splice(idx, 1)
  emit('update:modelValue', next)
}

const selectAll = () => {
  // Добавляем все видимые незаблокированные АЗС к уже выбранным
  const visible = filteredOptions.value
    .filter(o => !isDisabled(o.value))
    .map(o => o.value)
  emit('update:modelValue', [...new Set([...props.modelValue, ...visible])])
}

const clearAll = () => {
  emit('update:modelValue', [])
}
</script>

<template>
  <div class="space-y-1.5">
    <!-- Заголовок + кнопки "Все / Снять" -->
    <div class="flex items-center justify-between">
      <span class="text-xs text-gray-500 font-medium uppercase tracking-wide">{{ label }}</span>
      <div class="flex gap-2 text-xs">
        <button
          class="text-blue-600 hover:underline disabled:opacity-40"
          :disabled="isLoading"
          @click="selectAll"
        >
          Все
        </button>
        <span class="text-gray-300">|</span>
        <button
          class="text-gray-500 hover:underline"
          @click="clearAll"
        >
          Снять
        </button>
      </div>
    </div>

    <!-- Ошибка загрузки (только в режиме самостоятельной загрузки) -->
    <div
      v-if="loadError"
      class="flex items-center gap-1.5 text-[12px] text-red-600"
    >
      <span>Список АЗС не загрузился</span>
      <button
        class="underline hover:no-underline disabled:opacity-50"
        :disabled="isLoading"
        @click="loadOptions"
      >
        Повторить
      </button>
    </div>

    <!-- Поле поиска -->
    <div class="relative">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Поиск АЗС…"
        class="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
      >
      <button
        v-if="searchQuery"
        class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
        @click="searchQuery = ''"
      >
        ✕
      </button>
    </div>

    <!-- Скелетоны при первичной загрузке -->
    <div v-if="isLoading && resolvedOptions.length === 0" class="space-y-1">
      <SkeletonBlock v-for="n in 4" :key="n" height="2rem" rounded="rounded-md" />
    </div>

    <!-- Чекбокс-список АЗС -->
    <div
      v-else
      class="max-h-44 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100"
    >
      <label
        v-for="opt in filteredOptions"
        :key="opt.value"
        class="flex items-center gap-2 px-3 py-2 text-sm"
        :class="[
          isDisabled(opt.value)
            ? 'opacity-50 cursor-not-allowed'
            : 'cursor-pointer hover:bg-gray-50',
          modelValue.includes(opt.value) && !isDisabled(opt.value) ? 'bg-blue-50' : ''
        ]"
      >
        <input
          type="checkbox"
          :value="opt.value"
          :checked="modelValue.includes(opt.value)"
          :disabled="isDisabled(opt.value)"
          class="rounded border-gray-300 text-blue-600 disabled:opacity-50"
          @change="toggle(opt.value)"
        >
        <span
          :class="modelValue.includes(opt.value) && !isDisabled(opt.value)
            ? 'text-blue-800 font-medium'
            : 'text-gray-700'"
        >
          {{ opt.label }}
        </span>
        <!-- Метка для заблокированных АЗС -->
        <span
          v-if="isDisabled(opt.value)"
          class="ml-auto text-[10px] text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 shrink-0"
        >
          занята
        </span>
      </label>

      <!-- Пустые состояния -->
      <div
        v-if="resolvedOptions.length === 0 && !isLoading"
        class="px-3 py-2 text-xs text-gray-400"
      >
        Нет доступных АЗС
      </div>
      <div
        v-else-if="filteredOptions.length === 0"
        class="px-3 py-2 text-xs text-gray-400"
      >
        Ничего не найдено по «{{ searchQuery }}»
      </div>
    </div>

    <!-- Счётчик выбранных / заглушка -->
    <p class="text-xs text-gray-400">
      <span v-if="modelValue.length > 0" class="text-blue-600">
        Выбрано: {{ modelValue.length }}
      </span>
      <span v-else>{{ placeholder }}</span>
    </p>
  </div>
</template>
