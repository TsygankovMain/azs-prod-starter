<script setup lang="ts">
const reports = [
  { id: 1, date: '25.05.2026', azs: 'АЗС №14', admin: 'Иванов И.', status: 'DONE', photos: '5/5' },
  { id: 2, date: '25.05.2026', azs: 'АЗС №7', admin: 'Петров П.', status: 'EXPIRED', photos: '2/5' },
  { id: 3, date: '25.05.2026', azs: 'АЗС №3', admin: 'Сидоров А.', status: 'DONE', photos: '4/4' },
  { id: 4, date: '24.05.2026', azs: 'АЗС №21', admin: 'Кузнецова Л.', status: 'DONE', photos: '6/6' }
]

const getStatusColor = (status: string) => {
  return status === 'DONE'
    ? 'bg-green-100 text-green-800'
    : 'bg-red-100 text-red-800'
}

const getStatusText = (status: string) => {
  return status === 'DONE' ? 'Завершено' : 'Просрочено'
}
</script>

<template>
  <div class="bg-white border border-gray-200 rounded-lg overflow-hidden my-4">
    <!-- Header -->
    <div class="px-4 py-4 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-bold text-gray-900">Отчёты АЗС</h3>
        <button class="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded transition-colors">
          + Создать
        </button>
      </div>

      <!-- Filters -->
      <div class="grid grid-cols-3 gap-2">
        <div class="border border-gray-300 rounded px-2 py-1.5 bg-white">
          <label class="text-xs text-gray-600 font-medium block mb-0.5">Дата</label>
          <div class="text-sm text-gray-800">25.05.2026</div>
        </div>
        <div class="border border-gray-300 rounded px-2 py-1.5 bg-white">
          <label class="text-xs text-gray-600 font-medium block mb-0.5">АЗС</label>
          <div class="text-sm text-gray-800">Все АЗС</div>
        </div>
        <div class="border border-gray-300 rounded px-2 py-1.5 bg-white">
          <label class="text-xs text-gray-600 font-medium block mb-0.5">Статус</label>
          <div class="text-sm text-gray-800">Все</div>
        </div>
      </div>
    </div>

    <!-- Table -->
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="bg-gray-100 border-b border-gray-200">
          <tr>
            <th class="px-4 py-2.5 text-left font-medium text-gray-700 text-xs">Дата</th>
            <th class="px-4 py-2.5 text-left font-medium text-gray-700 text-xs">АЗС</th>
            <th class="px-4 py-2.5 text-left font-medium text-gray-700 text-xs">Администратор</th>
            <th class="px-4 py-2.5 text-left font-medium text-gray-700 text-xs">Статус</th>
            <th class="px-4 py-2.5 text-left font-medium text-gray-700 text-xs">Фото</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="report in reports" :key="report.id" class="border-b border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors">
            <td class="px-4 py-3 text-gray-900 font-medium">{{ report.date }}</td>
            <td class="px-4 py-3 text-gray-900">{{ report.azs }}</td>
            <td class="px-4 py-3 text-gray-700">{{ report.admin }}</td>
            <td class="px-4 py-3">
              <span :class="['inline-block px-2.5 py-1 rounded text-xs font-medium', getStatusColor(report.status)]">
                {{ getStatusText(report.status) }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-700 font-medium">{{ report.photos }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
