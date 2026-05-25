<script setup lang="ts">
const doneCount = 18
const totalCount = 23
const openCount = 3
const failedCount = 2
const donePercent = 78
</script>

<template>
  <div class="bg-white border border-gray-200 rounded-lg overflow-hidden my-4">
    <!-- Header row -->
    <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
      <div class="flex items-center gap-2">
        <button class="inline-flex items-center justify-center w-9 h-9 rounded-full text-gray-600 hover:bg-gray-100 transition-colors">
          ←
        </button>
        <h3 class="text-lg font-semibold text-gray-900">Проверка отчётов АЗС</h3>
      </div>
      <button class="inline-flex items-center justify-center w-6 h-6 rounded hover:bg-gray-100 transition-colors text-gray-600">
        ?
      </button>
    </div>

    <!-- Subtitle -->
    <div class="px-5 py-2 text-xs text-gray-500">Сегодня, 25 мая</div>

    <!-- Period switcher + button row -->
    <div class="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4 flex-wrap">
      <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm">
        <button class="px-3 py-1.5 font-medium bg-blue-50 text-blue-700">
          Сегодня
        </button>
        <button class="px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-50 border-l border-gray-200">
          Вчера
        </button>
        <button class="px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-50 border-l border-gray-200">
          Неделя
        </button>
        <button class="px-3 py-1.5 font-medium text-gray-600 hover:bg-gray-50 border-l border-gray-200">
          Выбрать дату
        </button>
      </div>
      <button class="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm">
        ⚡ Запросить отчёт сейчас
      </button>
    </div>

    <!-- Summary card -->
    <div class="px-5 py-5 border-b border-gray-100">
      <div class="flex items-end justify-between gap-4 mb-3">
        <div>
          <p class="text-xs text-gray-500 uppercase tracking-wide mb-1">СЕГОДНЯ</p>
          <p class="text-2xl">
            Сдали отчёт <span class="font-bold text-blue-700">{{ doneCount }} из {{ totalCount }}</span> АЗС
          </p>
        </div>
        <div class="text-right">
          <p class="text-3xl font-bold text-blue-600">{{ donePercent }}%</p>
          <p class="text-xs text-gray-500">сдачи</p>
        </div>
      </div>

      <!-- Progress bar -->
      <div class="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden flex mb-3">
        <div class="bg-green-500" :style="{ width: donePercent + '%' }"></div>
        <div class="bg-yellow-400" :style="{ width: ((openCount / totalCount) * 100) + '%' }"></div>
        <div class="bg-red-400" :style="{ width: ((failedCount / totalCount) * 100) + '%' }"></div>
      </div>

      <!-- Status chips -->
      <div class="flex flex-wrap gap-2">
        <button class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-100 hover:bg-green-200 text-green-800 text-xs font-medium transition-colors">
          <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
          Сдан {{ doneCount }}
        </button>
        <button class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-yellow-100 hover:bg-yellow-200 text-yellow-800 text-xs font-medium transition-colors">
          <span class="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>
          В работе {{ openCount }}
        </button>
        <button class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-100 hover:bg-red-200 text-red-800 text-xs font-medium transition-colors">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500"></span>
          Не сдан {{ failedCount }}
        </button>
      </div>
    </div>

    <!-- Two-column layout: feed + right panel -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-0">
      <!-- Feed (left) -->
      <div class="col-span-1 md:col-span-2 border-r border-gray-100 p-4">
        <h4 class="text-sm font-semibold text-gray-900 mb-3">Лента событий</h4>
        <div class="space-y-2">
          <!-- Sample event 1 (done - green) -->
          <div class="flex gap-2">
            <div class="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 text-green-700 flex items-center justify-center text-sm font-medium">
              ✓
            </div>
            <div class="flex-1">
              <p class="text-xs font-medium text-gray-900">АЗС №5 сдала отчёт</p>
              <p class="text-xs text-gray-500 mt-0.5">09:15</p>
            </div>
          </div>
          <!-- Sample event 2 (in progress - yellow) -->
          <div class="flex gap-2">
            <div class="flex-shrink-0 w-8 h-8 rounded-full bg-yellow-100 text-yellow-700 flex items-center justify-center text-sm font-medium">
              ⏳
            </div>
            <div class="flex-1">
              <p class="text-xs font-medium text-gray-900">АЗС №12 — фотографии загружаются</p>
              <p class="text-xs text-gray-500 mt-0.5">09:08</p>
            </div>
          </div>
          <!-- Sample event 3 (failed - red) -->
          <div class="flex gap-2">
            <div class="flex-shrink-0 w-8 h-8 rounded-full bg-red-100 text-red-700 flex items-center justify-center text-sm font-medium">
              ⚠
            </div>
            <div class="flex-1">
              <p class="text-xs font-medium text-red-900">АЗС №3 — отчёт не сдан вовремя</p>
              <p class="text-xs text-gray-500 mt-0.5">09:02</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Right panel -->
      <div class="col-span-1 p-4 space-y-4">
        <!-- Schedule card -->
        <div class="border border-gray-100 rounded-lg p-3">
          <h5 class="text-xs font-semibold text-gray-900 mb-2">📅 Расписание рассылки</h5>
          <div class="text-xs text-gray-600 space-y-1">
            <p>Времена: 09:00, 15:00</p>
            <p>Разброс: ±15 мин</p>
            <p>Таймаут: 30 мин</p>
          </div>
        </div>

        <!-- Quick request card -->
        <div class="border border-gray-100 rounded-lg p-3">
          <h5 class="text-xs font-semibold text-gray-900 mb-2">⚡ Запросить отчёт</h5>
          <p class="text-xs text-gray-600">Выберите АЗС и отправьте задание немедленно.</p>
        </div>
      </div>
    </div>
  </div>
</template>
