<script setup lang="ts"></script>

<template>
  <div class="flex justify-center my-4">
    <div class="w-[360px] bg-gradient-to-b from-gray-100 to-gray-50 rounded-xl shadow-lg overflow-hidden border border-gray-200">
      <!-- Status bar -->
      <div class="flex items-center justify-between px-3 py-2 text-xs bg-gray-900 text-white">
        <span class="font-medium">Bitrix24</span>
        <span>09:07</span>
      </div>

      <!-- Notification content -->
      <div class="px-4 py-3">
        <!-- Icon and title -->
        <div class="flex gap-3 mb-2">
          <div class="flex-shrink-0 w-10 h-10 rounded-full bg-blue-500 flex items-center justify-center text-white text-lg font-bold flex-shrink-0">
            B
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="text-sm font-bold text-gray-900 leading-tight">
              Время сделать отчёт АЗС
            </h4>
          </div>
        </div>

        <!-- Body text -->
        <p class="text-xs text-gray-700 leading-relaxed mb-3 ml-13">
          АЗС №14. У вас есть 30 минут на загрузку фото.
        </p>

        <!-- Action button -->
        <div class="flex gap-2 ml-13">
          <button class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded transition-colors">
            Открыть
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
