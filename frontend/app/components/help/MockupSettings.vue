<script setup lang="ts">
const azsFields = [
  { left: 'Название', right: 'TITLE' },
  { left: 'Администратор', right: 'UF_ADMIN' },
  { left: 'Обязательные фото', right: 'UF_REQUIRED_PHOTOS' }
]

const reportFields = [
  { left: 'Дата отчёта', right: 'UF_DATE' },
  { left: 'Статус', right: 'UF_STATUS' },
  { left: 'Фото', right: 'UF_PHOTOS' }
]
</script>

<template>
  <div class="space-y-3 my-4">
    <!-- AZS Smart Process Card -->
    <div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div class="px-4 py-3 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200">
        <h4 class="text-sm font-bold text-gray-900">Смарт-процесс АЗС</h4>
      </div>
      <div class="px-4 py-3 space-y-2.5">
        <div class="pb-2.5 border-b border-gray-100">
          <label class="text-xs text-gray-600 font-medium block mb-1">Смарт-процесс</label>
          <div class="text-sm text-gray-900 font-medium">Заправочные станции (entityTypeId 145)</div>
        </div>
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-gray-700 mb-2">Соответствие полей:</p>
          <div v-for="(field, idx) in azsFields" :key="idx" class="flex items-center justify-between text-xs">
            <span class="text-gray-700">{{ field.left }}</span>
            <span class="text-gray-500">→</span>
            <span class="font-mono text-gray-900 font-medium">{{ field.right }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Report Smart Process Card -->
    <div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div class="px-4 py-3 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200">
        <h4 class="text-sm font-bold text-gray-900">Смарт-процесс Отчёт</h4>
      </div>
      <div class="px-4 py-3 space-y-2.5">
        <div class="pb-2.5 border-b border-gray-100">
          <label class="text-xs text-gray-600 font-medium block mb-1">Смарт-процесс</label>
          <div class="text-sm text-gray-900 font-medium">Отчёт АЗС (entityTypeId 152)</div>
        </div>
        <div class="space-y-1.5">
          <p class="text-xs font-medium text-gray-700 mb-2">Соответствие полей:</p>
          <div v-for="(field, idx) in reportFields" :key="idx" class="flex items-center justify-between text-xs">
            <span class="text-gray-700">{{ field.left }}</span>
            <span class="text-gray-500">→</span>
            <span class="font-mono text-gray-900 font-medium">{{ field.right }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Schedule Card -->
    <div class="bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div class="px-4 py-3 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200">
        <h4 class="text-sm font-bold text-gray-900">Расписание</h4>
      </div>
      <div class="px-4 py-3 space-y-2">
        <div class="flex items-center justify-between py-1.5 border-b border-gray-100">
          <span class="text-xs text-gray-700">Время рассылки:</span>
          <span class="text-sm text-gray-900 font-medium">09:00</span>
        </div>
        <div class="flex items-center justify-between py-1.5 border-b border-gray-100">
          <span class="text-xs text-gray-700">Сдвиг ±X (мин):</span>
          <span class="text-sm text-gray-900 font-medium">15 мин</span>
        </div>
        <div class="flex items-center justify-between py-1.5">
          <span class="text-xs text-gray-700">Таймаут (мин):</span>
          <span class="text-sm text-gray-900 font-medium">30 мин</span>
        </div>
      </div>
    </div>
  </div>
</template>
