<script setup lang="ts">
/**
 * PhotoFilters — панель фильтров для фотоленты.
 * v-model единым объектом PhotoFiltersValue.
 * Паттерны: чекбокс-список с поиском из reviewer.client.vue,
 * деградация категорий с retry (S2-03), withPending-стиль.
 */

export type PhotoFilterPeriod = 'today' | 'yesterday' | 'week' | 'custom'
export type PhotoFilterRemarks = 'all' | 'with' | 'without'

export type PhotoFiltersValue = {
  period: PhotoFilterPeriod
  customDateFrom: string
  customDateTo: string
  azsIds: string[]
  categoryСodes: string[]
  remarks: PhotoFilterRemarks
  groupByAzs: boolean
}

type AzsOption = {
  value: string
  label: string
}

type Category = {
  code: string
  title: string
}

const props = defineProps<{
  modelValue: PhotoFiltersValue
  azsOptions: AzsOption[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: PhotoFiltersValue): void
  (e: 'change'): void
}>()

const apiStore = useApiStore()

// ── Локальные копии для удобного v-model ──────────────────────────────────
const filters = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})

function patch(partial: Partial<PhotoFiltersValue>) {
  emit('update:modelValue', { ...props.modelValue, ...partial })
  emit('change')
}

// ── Период ───────────────────────────────────────────────────────────────
const PERIODS: Array<{ key: PhotoFilterPeriod; label: string }> = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: 'Неделя' },
  { key: 'custom', label: 'Диапазон' },
]

const setPeriod = (p: PhotoFilterPeriod) => {
  patch({ period: p })
}

// ── Поиск по АЗС ─────────────────────────────────────────────────────────
const azsSearchQuery = ref('')
const filteredAzsOptions = computed(() => {
  const q = azsSearchQuery.value.trim().toLowerCase()
  if (!q) return props.azsOptions
  return props.azsOptions.filter(o =>
    o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)
  )
})

const toggleAzsSelection = (value: string) => {
  const current = [...props.modelValue.azsIds]
  const idx = current.indexOf(value)
  if (idx === -1) current.push(value)
  else current.splice(idx, 1)
  patch({ azsIds: current })
}

const selectAllAzs = () => {
  const visible = filteredAzsOptions.value.map(o => o.value)
  const merged = [...new Set([...props.modelValue.azsIds, ...visible])]
  patch({ azsIds: merged })
}

const clearAllAzs = () => {
  patch({ azsIds: [] })
}

// ── Категории ─────────────────────────────────────────────────────────────
const categories = ref<Category[]>([])
const categoriesLoading = ref(false)
const categoriesError = ref('')

const loadCategories = async () => {
  categoriesLoading.value = true
  categoriesError.value = ''
  try {
    const resp = await apiStore.getPhotoCategories()
    categories.value = resp.items
  } catch {
    categoriesError.value = 'Не удалось загрузить категории'
  } finally {
    categoriesLoading.value = false
  }
}

onMounted(loadCategories)

const toggleCategory = (code: string) => {
  const current = [...props.modelValue.categoryСodes]
  const idx = current.indexOf(code)
  if (idx === -1) current.push(code)
  else current.splice(idx, 1)
  patch({ categoryСodes: current })
}

const isCategoryActive = (code: string) => props.modelValue.categoryСodes.includes(code)

// ── Замечания — циклический чип ────────────────────────────────────────────
const REMARKS_CYCLE: PhotoFilterRemarks[] = ['all', 'with', 'without']
const REMARKS_LABELS: Record<PhotoFilterRemarks, string> = {
  all: 'Замечания: все',
  with: 'Замечания: с замечаниями',
  without: 'Замечания: без'
}

const cycleRemarks = () => {
  const idx = REMARKS_CYCLE.indexOf(props.modelValue.remarks)
  const next = REMARKS_CYCLE[(idx + 1) % REMARKS_CYCLE.length]
  patch({ remarks: next })
}

// ── Тумблер «По АЗС» ──────────────────────────────────────────────────────
const toggleGroupByAzs = () => {
  patch({ groupByAzs: !props.modelValue.groupByAzs })
}
</script>

<template>
  <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 space-y-4">

    <!-- Период -->
    <div class="space-y-2">
      <p class="text-xs text-gray-500 font-medium uppercase tracking-wide">Период</p>
      <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm flex-wrap">
        <button
          v-for="p in PERIODS"
          :key="p.key"
          :class="[
            'px-3 py-2 font-medium transition-colors border-l border-gray-200 first:border-l-0',
            filters.period === p.key
              ? 'bg-blue-50 text-blue-700'
              : 'text-gray-600 hover:bg-gray-50'
          ]"
          @click="setPeriod(p.key)"
        >
          {{ p.label }}
        </button>
      </div>

      <!-- Диапазон: два date-инпута -->
      <div v-if="filters.period === 'custom'" class="flex gap-2 items-center">
        <input
          :value="filters.customDateFrom"
          type="date"
          class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
          @change="patch({ customDateFrom: ($event.target as HTMLInputElement).value })"
        >
        <span class="text-gray-400">—</span>
        <input
          :value="filters.customDateTo"
          type="date"
          class="px-3 py-2 rounded-lg border border-gray-200 text-sm"
          @change="patch({ customDateTo: ($event.target as HTMLInputElement).value })"
        >
      </div>
    </div>

    <!-- Фильтр АЗС — чекбокс-список с поиском (паттерн reviewer.client.vue) -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-xs text-gray-500 font-medium uppercase tracking-wide">АЗС</p>
        <div class="flex gap-2 text-xs">
          <button class="text-blue-600 hover:underline" @click="selectAllAzs">Все</button>
          <span class="text-gray-300">|</span>
          <button class="text-gray-500 hover:underline" @click="clearAllAzs">Снять</button>
        </div>
      </div>

      <div class="relative">
        <input
          v-model="azsSearchQuery"
          type="text"
          placeholder="Поиск АЗС…"
          class="w-full rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300"
        >
        <button
          v-if="azsSearchQuery"
          class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
          @click="azsSearchQuery = ''"
        >
          ✕
        </button>
      </div>

      <div class="max-h-44 overflow-y-auto border border-gray-200 rounded-md bg-white divide-y divide-gray-100">
        <label
          v-for="opt in filteredAzsOptions"
          :key="opt.value"
          class="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-gray-50"
          :class="{ 'bg-blue-50': filters.azsIds.includes(opt.value) }"
        >
          <input
            type="checkbox"
            :value="opt.value"
            :checked="filters.azsIds.includes(opt.value)"
            class="rounded border-gray-300 text-blue-600"
            @change="toggleAzsSelection(opt.value)"
          >
          <span :class="filters.azsIds.includes(opt.value) ? 'text-blue-800 font-medium' : 'text-gray-700'">
            {{ opt.label }}
          </span>
        </label>
        <div v-if="azsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
          Нет доступных АЗС
        </div>
        <div v-else-if="filteredAzsOptions.length === 0" class="px-3 py-2 text-xs text-gray-400">
          Ничего не найдено по «{{ azsSearchQuery }}»
        </div>
      </div>

      <p class="text-xs text-gray-400">
        <span v-if="filters.azsIds.length > 0" class="text-blue-600">Выбрано: {{ filters.azsIds.length }}</span>
        <span v-else>Все АЗС</span>
      </p>
    </div>

    <!-- Категории — деградация с retry (S2-03) -->
    <div class="space-y-2">
      <p class="text-xs text-gray-500 font-medium uppercase tracking-wide">Категория фото</p>

      <!-- Загрузка -->
      <div v-if="categoriesLoading" class="flex gap-1.5 flex-wrap">
        <SkeletonBlock v-for="n in 4" :key="n" height="1.75rem" :width="`${60 + n * 10}px`" rounded="rounded-full" />
      </div>

      <!-- Ошибка с Повторить (S2-03) -->
      <div v-else-if="categoriesError" class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-red-600">{{ categoriesError }}</span>
        <button
          class="text-xs text-blue-600 hover:underline"
          @click="loadCategories"
        >
          ↻ Повторить
        </button>
      </div>

      <!-- Чипы категорий -->
      <div v-else-if="categories.length > 0" class="flex gap-1.5 flex-wrap">
        <button
          :class="[
            'border rounded-full px-3 py-1 text-xs font-medium transition-colors',
            filters.categoryСodes.length === 0
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          ]"
          @click="patch({ categoryСodes: [] })"
        >
          Все
        </button>
        <button
          v-for="cat in categories"
          :key="cat.code"
          :class="[
            'border rounded-full px-3 py-1 text-xs font-medium transition-colors',
            isCategoryActive(cat.code)
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
          ]"
          @click="toggleCategory(cat.code)"
        >
          {{ cat.title || cat.code }}
        </button>
      </div>

      <div v-else class="text-xs text-gray-400">
        Категории не загружены
      </div>
    </div>

    <!-- Замечания — циклический чип -->
    <div class="flex items-center gap-3 flex-wrap">
      <button
        :class="[
          'border rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
          filters.remarks !== 'all'
            ? 'bg-amber-50 text-amber-800 border-amber-300'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        ]"
        @click="cycleRemarks"
      >
        {{ REMARKS_LABELS[filters.remarks] }}
      </button>

      <!-- Тумблер «По АЗС» -->
      <button
        :class="[
          'border rounded-full px-3 py-1.5 text-xs font-medium transition-colors flex items-center gap-1.5',
          filters.groupByAzs
            ? 'bg-blue-50 text-blue-700 border-blue-300'
            : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
        ]"
        @click="toggleGroupByAzs"
      >
        <span
          :class="[
            'w-3 h-3 rounded-full border transition-colors',
            filters.groupByAzs ? 'bg-blue-600 border-blue-600' : 'bg-white border-gray-400'
          ]"
        />
        По АЗС
      </button>
    </div>
  </div>
</template>
