<script setup lang="ts">
import { ref } from 'vue'

const positions = ref([
  { id: 1, name: 'Колонки 1-2', done: true },
  { id: 2, name: 'Кассовая зона', done: true },
  { id: 3, name: 'Туалет', done: false },
  { id: 4, name: 'Витрина магазина', done: false },
  { id: 5, name: 'Входная группа', done: false }
])

const allDone = ref(false)
</script>

<template>
  <!-- Phone frame -->
  <div class="flex justify-center my-6">
    <div class="w-[390px] h-[720px] rounded-[48px] border-8 border-gray-800 shadow-2xl bg-black p-3 flex flex-col">
      <!-- Notch -->
      <div class="w-[120px] h-6 rounded-b-2xl bg-black mx-auto mb-1" />

      <!-- Screen -->
      <div class="flex-1 bg-white rounded-[40px] overflow-hidden flex flex-col">
        <!-- Status bar -->
        <div class="px-4 py-3 bg-gradient-to-b from-gray-50 to-white border-b border-gray-200">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-medium text-gray-500">Отчёт АЗС</span>
            <span class="text-xs text-gray-400">09:37</span>
          </div>

          <!-- Title and info -->
          <h2 class="text-lg font-bold text-gray-900 mb-1">Отчёт от 25.05.2026</h2>
          <p class="text-xs text-gray-600 mb-2">АЗС №14 — Ленинский проспект</p>

          <!-- Status badge and timer -->
          <div class="flex items-center justify-between">
            <span class="inline-block px-2.5 py-1 bg-yellow-100 text-yellow-800 text-xs font-medium rounded">
              В работе
            </span>
            <span class="text-xs text-red-600 font-medium">⏱ Осталось 12 минут</span>
          </div>
        </div>

        <!-- Photos list -->
        <div class="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
          <div v-for="pos in positions" :key="pos.id" class="bg-gray-50 rounded-lg p-3 border border-gray-200 hover:bg-gray-100 transition-colors">
            <div class="flex items-center justify-between mb-2">
              <span class="text-sm font-medium text-gray-900">{{ pos.name }}</span>
              <span v-if="pos.done" class="text-green-600 text-sm font-medium flex items-center gap-1">
                ✓ Готово
              </span>
              <span v-else class="text-gray-500 text-sm flex items-center gap-1">
                🔴 Требуется
              </span>
            </div>
            <button
              v-if="!pos.done"
              class="w-full px-3 py-2 bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-xs font-medium rounded transition-colors flex items-center justify-center gap-1"
            >
              📷 Сделать фото
            </button>
            <button
              v-else
              disabled
              class="w-full px-3 py-2 bg-gray-200 text-gray-500 text-xs font-medium rounded cursor-not-allowed opacity-60"
            >
              📷 Фото готово
            </button>
          </div>
        </div>

        <!-- Bottom action -->
        <div class="px-3 py-4 border-t border-gray-200 bg-white">
          <button
            disabled
            class="w-full px-4 py-3 bg-gray-300 text-gray-500 text-sm font-medium rounded-lg cursor-not-allowed transition-colors"
          >
            Сдать отчёт
          </button>
          <p class="text-xs text-gray-500 text-center mt-2">Загрузите все фото, чтобы сдать отчёт</p>
        </div>
      </div>
    </div>
  </div>
</template>
