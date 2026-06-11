<script setup lang="ts">
/**
 * RemarkDraftPanel — панель-черновик отправки замечания (спека §4.3, С1–С3, С5).
 * Рендерится в двух контекстах: sticky-снизу в сетке и нижний блок в лайтбоксе.
 * Весь state черновика живёт в родителе (photos.client.vue);
 * панель только отображает его и эмитит события.
 *
 * withPending-паттерн: кнопка «Отправить» заблокирована на время запроса через isSending prop.
 */

export type RemarkRecipient = {
  id: number
  name: string
} | null

const props = defineProps<{
  /** Текущее кол-во отмеченных фото */
  count: number
  /** Ключ АЗС (id) */
  azsId: string
  /** Название АЗС для заголовка */
  azsTitle: string
  /** Получатель «Управляющий» (null если не заполнен в карточке АЗС) */
  manager: RemarkRecipient
  /** Получатель «Администратор АЗС» (null если не заполнен) */
  admin: RemarkRecipient
  /** true когда список получателей грузится */
  recipientsLoading: boolean
  /** Шаблоны из настроек приложения */
  templates: string[]
  /** true при активной отправке (withPending-блокировка) */
  isSending: boolean
}>()

const emit = defineEmits<{
  send: [payload: { recipientRole: 'manager' | 'admin'; message: string }]
  clear: []
}>()

type RecipientRole = 'manager' | 'admin'

const selectedRole = ref<RecipientRole>('manager')
const message = ref('')

// Авто-переключение на admin если manager null (С5)
watch(
  () => props.manager,
  (mgr) => {
    if (!mgr && selectedRole.value === 'manager') {
      selectedRole.value = 'admin'
    }
  },
  { immediate: true }
)

const currentRecipient = computed<RemarkRecipient>(() =>
  selectedRole.value === 'manager' ? props.manager : props.admin
)

const neitherAvailable = computed(() => !props.manager && !props.admin && !props.recipientsLoading)

const canSend = computed(() =>
  !neitherAvailable.value &&
  currentRecipient.value !== null &&
  message.value.trim().length > 0 &&
  !props.isSending
)

const applyTemplate = (tmpl: string) => {
  message.value = tmpl
}

const handleSend = () => {
  if (!canSend.value) return
  emit('send', {
    recipientRole: selectedRole.value,
    message: message.value.trim()
  })
}

const handleClear = () => {
  message.value = ''
  selectedRole.value = 'manager'
  emit('clear')
}

// Когда count приходит 0 (после очистки снаружи), очищаем локальное сообщение
watch(
  () => props.count,
  (n) => {
    if (n === 0) {
      message.value = ''
      selectedRole.value = 'manager'
    }
  }
)
</script>

<template>
  <div class="bg-white border-t border-gray-200 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] rounded-t-2xl p-4 space-y-3">

    <!-- Заголовок -->
    <div class="flex items-center justify-between">
      <div class="text-sm font-semibold text-gray-800">
        {{ azsTitle }} · {{ count }} фото
      </div>
      <button
        class="text-xs text-gray-400 hover:text-gray-600 transition-colors px-2 py-1"
        @click="handleClear"
      >
        Очистить
      </button>
    </div>

    <!-- Нет получателей совсем — ошибочное состояние (С5 крайний случай) -->
    <div
      v-if="neitherAvailable"
      class="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700"
    >
      У АЗС не указан ни управляющий, ни администратор. Замечание не может быть отправлено.
    </div>

    <template v-else>
      <!-- Загрузка получателей -->
      <div
        v-if="recipientsLoading"
        class="flex items-center gap-2 text-sm text-gray-400"
      >
        <span class="animate-pulse">Загрузка получателей…</span>
      </div>

      <!-- Выпадашка «Кому» -->
      <div
        v-else
        class="space-y-1"
      >
        <label class="block text-xs text-gray-500">Кому</label>

        <!-- Предупреждение С5: нет управляющего -->
        <div
          v-if="!manager"
          class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-1.5 mb-1"
        >
          У АЗС не указан управляющий — выбран администратор
        </div>

        <div class="inline-flex rounded-lg border border-gray-200 bg-white overflow-hidden text-sm">
          <button
            :class="[
              'px-3 py-2 font-medium transition-colors border-r border-gray-200',
              selectedRole === 'manager'
                ? 'bg-blue-50 text-blue-700'
                : 'text-gray-500 hover:bg-gray-50',
              !manager ? 'opacity-40 cursor-not-allowed' : ''
            ]"
            :disabled="!manager"
            @click="selectedRole = 'manager'"
          >
            Управляющему{{ manager ? ` (${manager.name})` : '' }}
          </button>
          <button
            :class="[
              'px-3 py-2 font-medium transition-colors',
              selectedRole === 'admin'
                ? 'bg-blue-50 text-blue-700'
                : 'text-gray-500 hover:bg-gray-50',
              !admin ? 'opacity-40 cursor-not-allowed' : ''
            ]"
            :disabled="!admin"
            @click="selectedRole = 'admin'"
          >
            Администратору{{ admin ? ` (${admin.name})` : '' }}
          </button>
        </div>
      </div>

      <!-- Шаблоны -->
      <div
        v-if="templates.length > 0"
        class="flex flex-wrap gap-2"
      >
        <button
          v-for="tmpl in templates"
          :key="tmpl"
          class="px-3 py-1.5 text-xs rounded-full border border-gray-200 bg-white hover:bg-gray-50 text-gray-700 transition-colors"
          @click="applyTemplate(tmpl)"
        >
          {{ tmpl }}
        </button>
      </div>

      <!-- Textarea -->
      <textarea
        v-model="message"
        rows="2"
        placeholder="Текст замечания…"
        class="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none"
      />

      <!-- Кнопка отправки -->
      <div class="flex items-center gap-2">
        <button
          :disabled="!canSend"
          class="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          :class="canSend ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-200 text-gray-500'"
          @click="handleSend"
        >
          {{ isSending ? 'Отправка…' : `Отправить (${count})` }}
        </button>
      </div>
    </template>

  </div>
</template>
