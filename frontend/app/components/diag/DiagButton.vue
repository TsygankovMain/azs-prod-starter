<script setup lang="ts">
/**
 * Кнопка «Что-то не работает» — ручная отправка диаг-бандла.
 *
 * Называет ситуацию оператора, а не наш инструмент: человек не хочет
 * «собирать логи», он хочет перестать быть виноватым и вернуться к работе.
 * Ставится там, где оператор уже застрял — рядом с ошибкой загрузки на
 * экране отчёта и на экране ошибки приложения (DiagButton там — не
 * единственный, а единственный вообще кликабельный элемент).
 *
 * role приходит пропсом, а не из useUserStore(): стор хранит только
 * id/login/isAdmin, роль резолвится постранично.
 */
// Fix round (ревью, BLOCKING 1): composables/diag/ — первая вложенная папка
// в app/composables/ в этом проекте, Nuxt авто-импортирует только верхний
// уровень. Без явного import useDiagSender() был ReferenceError на первом же
// клике.
import { useDiagSender } from '~/composables/diag/useDiagSender'

const props = withDefaults(defineProps<{
  azsId?: string
  reportId?: number | null
  role?: string
  variant?: 'inline' | 'block'
}>(), { azsId: '', reportId: null, role: '', variant: 'inline' })

const { send } = useDiagSender()
const toast = useAppToast()
const route = useRoute()
const userStore = useUserStore()
const busy = ref(false)

const onClick = async () => {
  if (busy.value) return
  busy.value = true
  try {
    const result = await send('button', {
      // build/isDemo — константы в этапе 1: nuxt.config.ts этот план не трогает
      // (см. врезку в Task 7), ключей appBuild и demo в закоммиченном конфиге нет.
      app: { build: 'unknown', route: String(route.fullPath || ''), isDemo: false },
      user: {
        // stores/user.ts держит id/login/isAdmin — полей userId и role там нет.
        userId: Number(userStore.id || 0),
        azsId: props.azsId,
        reportId: props.reportId,
        role: props.role
      }
    })
    if (result.ok && result.code) {
      toast.success(`Диагностика отправлена. Код: ${result.code}. Назовите его поддержке.`)
    } else if (result.queued) {
      // Только этот случай реально означает «сохранена и уйдёт сама»: бандл
      // лёг в очередь ретрая (сеть/5xx), и flushPending() на следующем
      // запуске приложения её дожмёт (fix round, BLOCKING 3).
      toast.info('Диагностика сохранена на устройстве и уйдёт, когда появится связь.')
    } else {
      // Троттлинг (недавно уже отправляли) или отказ сервера — бандл никуда
      // не сохранён и сам не уйдёт. Раньше текст был одинаков для всех
      // случаев и врал оператору именно здесь.
      toast.info('Не удалось отправить диагностику. Попробуйте ещё раз через минуту.')
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <B24Button
    color="air-secondary"
    :variant="props.variant === 'block' ? 'solid' : 'outline'"
    :loading="busy"
    label="Что-то не работает"
    @click="onClick"
  />
</template>
