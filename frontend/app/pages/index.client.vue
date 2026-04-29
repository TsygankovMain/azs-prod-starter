<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

const PAGE_TITLE = 'Фото-отчёты АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('AppHomePage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const userStore = useUserStore()
const route = useRoute()

let $b24: null | B24Frame = null

const isInit = ref(false)
const isLoading = ref(false)
const healthStatus = ref<'unknown' | 'ok' | 'error'>('unknown')
const healthText = ref('Проверка API...')

const appScreens = [
  {
    key: 'settings',
    title: 'Настройки',
    description: 'Маппинг смарт-процессов, стадий, дедлайнов и параметров диска.',
    path: '/settings'
  },
  {
    key: 'reviewer',
    title: 'Экран Проверяющего',
    description: 'Список отчётов, статусы, фильтры и ручной запуск запроса фото.',
    path: '/reviewer'
  },
  {
    key: 'admin',
    title: 'Экран Администратора АЗС',
    description: 'Мобильная форма загрузки фото по позициям отчёта.',
    path: '/admin/1'
  }
] as const

const openPage = async (path: string) => {
  await navigateTo(path)
}

const parsePositiveInt = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0
  }
  return Math.floor(parsed)
}

const parseReportIdFromPath = (value: unknown): number => {
  const match = String(value || '').match(/\/admin\/(\d+)/)
  return parsePositiveInt(match?.[1])
}

const parsePlacementOptions = ($frame: B24Frame): Record<string, unknown> => {
  const raw = $frame.placement?.options
  if (!raw) {
    return {}
  }
  if (typeof raw === 'object') {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

const resolveContextReportId = ($frame: B24Frame): number => {
  const direct = parsePositiveInt(route.query.reportId)
  if (direct > 0) {
    return direct
  }

  const bracket = parsePositiveInt(route.query['params[reportId]'])
  if (bracket > 0) {
    return bracket
  }

  const fromQueryPath = parseReportIdFromPath(route.query.path ?? route.query['params[path]'])
  if (fromQueryPath > 0) {
    return fromQueryPath
  }

  const placementOptions = parsePlacementOptions($frame)
  const fromPlacement = parsePositiveInt(placementOptions.reportId ?? placementOptions['params[reportId]'])
  if (fromPlacement > 0) {
    return fromPlacement
  }

  return parseReportIdFromPath(placementOptions.path ?? placementOptions['params[path]'])
}

const checkBackend = async () => {
  try {
    await apiStore.checkHealth()
    healthStatus.value = 'ok'
    healthText.value = 'Backend доступен'
  } catch {
    healthStatus.value = 'error'
    healthText.value = 'Backend недоступен или JWT не инициализирован'
  }
}

onMounted(async () => {
  try {
    isLoading.value = true
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)

    const contextReportId = resolveContextReportId($b24)
    if (contextReportId > 0) {
      await navigateTo(`/admin/${contextReportId}`)
      return
    }

    await checkBackend()
    isInit.value = true
  } catch (error) {
    processErrorGlobal(error)
  } finally {
    isLoading.value = false
  }
})
</script>

<template>
  <div class="w-full max-w-[1120px] mx-auto px-4 py-4 space-y-4">
    <B24Card>
      <template #header>
        <div class="flex flex-row items-center justify-between gap-3">
          <div>
            <ProseH2>Фото-отчёты АЗС</ProseH2>
            <ProseP>Рабочие экраны приложения на Bitrix24 UI Kit.</ProseP>
          </div>
          <B24Badge :color="healthStatus === 'ok' ? 'air-primary-success' : (healthStatus === 'error' ? 'air-primary-alert' : 'air-secondary')">
            {{ healthText }}
          </B24Badge>
        </div>
      </template>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <B24Card
          v-for="screen in appScreens"
          :key="screen.key"
          variant="outline"
          :b24ui="{
            body: 'space-y-3'
          }"
        >
          <ProseH3>{{ screen.title }}</ProseH3>
          <ProseP class="text-[13px]">{{ screen.description }}</ProseP>
          <B24Button
            color="air-primary"
            variant="solid"
            :label="`Открыть: ${screen.title}`"
            loading-auto
            @click="openPage(screen.path)"
          />
        </B24Card>
      </div>

      <template #footer>
        <div class="flex flex-row items-center justify-between w-full gap-3">
          <ProseP class="text-[12px] text-gray-500">
            Пользователь: {{ userStore.id || 'unknown' }} | Админ: {{ userStore.isAdmin ? 'yes' : 'no' }}
          </ProseP>
          <B24Button
            color="air-secondary"
            label="Проверить API ещё раз"
            loading-auto
            @click="checkBackend"
          />
        </div>
      </template>
    </B24Card>

    <B24Alert
      v-if="!isInit && !isLoading"
      color="air-primary-alert"
      title="Инициализация не завершена"
      description="Проверьте запуск через Bitrix24 iframe и доступность backend."
    />
  </div>
</template>
