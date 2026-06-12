<script setup lang="ts">
/**
 * RemarkDraftPanel — панель-черновик пофотных замечаний (UX-2).
 * Показывает список отмеченных фото с их комментариями (редактируемыми),
 * кнопку × для удаления каждого фото, выбор получателя и кнопку «Отправить (N)».
 * Нет глобального textarea — коммент живёт в каждой строке.
 */

export type RemarkRecipient = {
  id: number
  name: string
} | null

type MarkEntry = {
  reportId: number
  photoCode: string
  azsId: string
  azsTitle: string
  comment: string
}

const props = defineProps<{
  /** Map отмеченных фото */
  marks: Map<string, MarkEntry>
  /** Ключ АЗС (id) */
  azsId: string
  /** Название АЗС для заголовка */
  azsTitle: string
  /** Получатель «Управляющий» */
  manager: RemarkRecipient
  /** Получатель «Администратор АЗС» */
  admin: RemarkRecipient
  /** true когда список получателей грузится */
  recipientsLoading: boolean
  /** true при активной отправке */
  isSending: boolean
}>()

const emit = defineEmits<{
  send: [payload: { recipientRole: 'manager' | 'admin' }]
  clear: []
  'update:selectedRole': [value: 'manager' | 'admin']
  'update-comment': [payload: { key: string; comment: string }]
  'remove-mark': [key: string]
}>()

type RecipientRole = 'manager' | 'admin'

const selectedRole = defineModel<RecipientRole>('selectedRole', { default: 'manager' })

// Авто-переключение на admin если manager null
watch(
  () => props.manager,
  (mgr) => {
    if (!mgr && selectedRole.value === 'manager') {
      selectedRole.value = props.admin ? 'admin' : 'manager'
    }
  },
  { immediate: true }
)

const currentRecipient = computed<RemarkRecipient>(() =>
  selectedRole.value === 'manager' ? props.manager : props.admin
)

const neitherAvailable = computed(() => !props.manager && !props.admin && !props.recipientsLoading)

const count = computed(() => props.marks.size)

// Все фото должны иметь непустой комментарий
const missingComments = computed<string[]>(() => {
  const keys: string[] = []
  for (const [key, entry] of props.marks.entries()) {
    if (!entry.comment.trim()) keys.push(key)
  }
  return keys
})

const canSend = computed(() =>
  !neitherAvailable.value &&
  currentRecipient.value !== null &&
  count.value > 0 &&
  missingComments.value.length === 0 &&
  !props.isSending
)

const handleSend = () => {
  if (!canSend.value) return
  emit('send', { recipientRole: selectedRole.value })
}

const handleClear = () => {
  selectedRole.value = props.manager ? 'manager' : 'admin'
  emit('clear')
}

const entries = computed(() => [...props.marks.entries()])

const getCategoryLabel = (entry: MarkEntry): string =>
  `${entry.azsTitle} · ${entry.photoCode}`
</script>

<template>
  <div class="bg-white border-t border-gray-200 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] rounded-t-2xl p-4 space-y-3 max-h-[60vh] overflow-y-auto">

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

    <!-- Нет получателей совсем -->
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

      <!-- Выбор получателя -->
      <div
        v-else
        class="space-y-1"
      >
        <label class="block text-xs text-gray-500">Кому</label>
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

      <!-- Список отмеченных фото -->
      <div class="space-y-2">
        <div
          v-for="[key, entry] in entries"
          :key="key"
          class="flex items-start gap-2 bg-gray-50 rounded-xl p-2.5 border"
          :class="!entry.comment.trim() ? 'border-red-200 bg-red-50' : 'border-gray-100'"
        >
          <div class="flex-1 min-w-0">
            <p class="text-xs text-gray-500 mb-1 truncate">{{ getCategoryLabel(entry) }}</p>
            <textarea
              :value="entry.comment"
              rows="2"
              placeholder="Комментарий к фото…"
              class="w-full rounded-lg border px-2 py-1.5 text-sm text-gray-800 placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none"
              :class="!entry.comment.trim() ? 'border-red-300 bg-white' : 'border-gray-200 bg-white'"
              @input="emit('update-comment', { key, comment: ($event.target as HTMLTextAreaElement).value })"
            />
            <p
              v-if="!entry.comment.trim()"
              class="text-xs text-red-500 mt-0.5"
            >
              Комментарий обязателен
            </p>
          </div>
          <button
            class="mt-5 flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors text-sm"
            :title="`Убрать ${getCategoryLabel(entry)}`"
            @click="emit('remove-mark', key)"
          >
            ×
          </button>
        </div>
      </div>

      <!-- Предупреждение о незаполненных комментариях -->
      <div
        v-if="missingComments.length > 0"
        class="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"
      >
        {{ missingComments.length }} фото без комментария — заполните перед отправкой
      </div>

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
