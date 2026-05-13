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
const homeNotice = ref('')
const currentRole = ref<'admin' | 'reviewer' | 'azs_admin'>('azs_admin')
const currentCapabilities = ref({
  settings: false,
  reviewer: false,
  reports: true
})

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
    path: '/admin'
  }
] as const

const visibleScreens = computed(() => appScreens.filter((screen) => {
  if (screen.key === 'settings') {
    return Boolean(currentCapabilities.value.settings)
  }
  if (screen.key === 'reviewer') {
    return Boolean(currentCapabilities.value.reviewer)
  }
  if (screen.key === 'admin') {
    return Boolean(currentCapabilities.value.reports)
  }
  return false
}))

const openPage = async (path: string) => {
  await navigateTo(path)
}

const openAdminReport = async () => {
  homeNotice.value = ''
  const response = await apiStore.getMyActiveReport(20)
  const reportId = Number(response?.item?.id || 0)
  if (reportId > 0) {
    await navigateTo(`/admin/${reportId}`)
    return
  }
  homeNotice.value = 'Нет активного отчёта для загрузки. Дождитесь уведомления бота или создайте отчёт вручную из раздела Проверка.'
}

const openScreen = async (screen: { key: string, path: string }) => {
  if (screen.key === 'admin') {
    await openAdminReport()
    return
  }
  await openPage(screen.path)
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
    const health = await apiStore.checkHealth()
    const roleResponse = await apiStore.getMyRole()
    if (roleResponse?.role) {
      currentRole.value = roleResponse.role
    } else if (health?.role) {
      currentRole.value = health.role
    }

    const capabilities = roleResponse?.capabilities ?? health?.capabilities
    currentCapabilities.value = {
      settings: Boolean(capabilities?.settings),
      reviewer: Boolean(capabilities?.reviewer),
      reports: Boolean(capabilities?.reports)
    }

    healthStatus.value = 'ok'
    healthText.value = 'Backend доступен'
  } catch {
    healthStatus.value = 'error'
    healthText.value = 'Backend недоступен или JWT не инициализирован'
  }
}

const openMyActiveReportIfAny = async () => {
  try {
    const response = await apiStore.getMyActiveReport(20)
    const reportId = Number(response?.item?.id || 0)
    if (reportId > 0) {
      await navigateTo(`/admin/${reportId}`)
      return true
    }
  } catch {
    // Keep home screen available even if active report lookup failed.
  }
  return false
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
    if (currentRole.value === 'azs_admin') {
      const redirectedToActive = await openMyActiveReportIfAny()
      if (redirectedToActive) {
        return
      }
    }
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
          v-for="screen in visibleScreens"
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
            @click="openScreen(screen)"
          />
        </B24Card>
      </div>

      <B24Alert
        v-if="homeNotice"
        class="mt-3"
        color="air-secondary"
        title="Подсказка"
        :description="homeNotice"
      />

      <template #footer>
        <div class="flex flex-row items-center justify-between w-full gap-3">
          <ProseP class="text-[12px] text-gray-500">
            Пользователь: {{ userStore.id || 'unknown' }} | Портал-админ: {{ userStore.isAdmin ? 'yes' : 'no' }} | Роль: {{ currentRole }}
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
