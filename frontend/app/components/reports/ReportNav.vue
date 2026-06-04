<script setup lang="ts">
type Tab = 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
defineProps<{ active: Tab; mobile?: boolean }>()
const emit = defineEmits<{ 'update:active': [v: Tab] }>()

const tabs: Array<{ id: Tab; label: string; sub: string }> = [
  { id: 'r1', label: 'Сводка за день',   sub: 'операционка' },
  { id: 'r2', label: 'Рейтинг АЗС',      sub: 'дисциплина' },
  { id: 'r3', label: 'Динамика',          sub: 'тренд по дням' },
  { id: 'r4', label: 'Карточка АЗС',      sub: 'таймлайн + фото' },
  { id: 'r5', label: 'Фото-витрина',      sub: 'фото за день' },
]
</script>

<template>
  <!-- Десктоп: вертикальное меню -->
  <nav v-if="!mobile"
    class="w-[248px] bg-white border-r border-gray-200 px-2.5 py-3.5 sticky top-0 h-screen overflow-auto flex-shrink-0"
  >
    <div class="text-[11px] uppercase tracking-[0.6px] text-gray-400 px-3 py-2 mb-1">Отчёты</div>
    <button
      v-for="tab in tabs" :key="tab.id"
      :class="[
        'w-full text-left flex gap-2.5 items-center px-3 py-2.5 rounded-[10px] mb-0.5 font-semibold text-[13.5px] transition-colors',
        active === tab.id
          ? 'bg-blue-50 text-blue-600'
          : 'text-[#33485f] hover:bg-gray-100'
      ]"
      @click="emit('update:active', tab.id)"
    >
      <span class="flex-1">
        <span class="block">{{ tab.label }}</span>
        <span class="block font-medium text-[11.5px]" :class="active === tab.id ? 'text-blue-400' : 'text-gray-400'">{{ tab.sub }}</span>
      </span>
    </button>
  </nav>

  <!-- Мобиль: нижняя панель -->
  <nav v-else
    class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex gap-1 overflow-x-auto px-2 py-2 z-40"
  >
    <button
      v-for="tab in tabs" :key="tab.id"
      :class="[
        'flex flex-col items-center gap-1 min-w-[70px] px-1.5 py-2 rounded-[10px] text-[11px] font-semibold transition-colors',
        active === tab.id ? 'bg-blue-50 text-blue-600' : 'text-gray-500 hover:bg-gray-50'
      ]"
      @click="emit('update:active', tab.id)"
    >
      {{ tab.label.split(' ')[0] }}
    </button>
  </nav>
</template>
