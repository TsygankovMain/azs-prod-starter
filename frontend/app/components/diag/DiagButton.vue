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
    } else {
      toast.info('Диагностика сохранена на устройстве и уйдёт, когда появится связь.')
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
