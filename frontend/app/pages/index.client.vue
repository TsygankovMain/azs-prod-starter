<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'
import Logo from '~/components/Logo.vue'

const PAGE_TITLE = 'Фото-отчёты АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('AppHomePage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()
const userStore = useUserStore()
const route = useRoute()
const toast = useAppToast()

let $b24: null | B24Frame = null

const isInit = ref(false)
const isAzsAdminWaiting = ref(false)
const isLoading = ref(false)
const openingReport = ref(false)
const healthStatus = ref<'unknown' | 'ok' | 'error'>('unknown')
const healthText = ref('Проверка API...')
const homeNotice = ref('')
const currentRole = ref<'admin' | 'reviewer' | 'azs_admin'>('azs_admin')

// Step tracker for the loading panel (index 0 = B24 connect, 1 = role check, 2 = redirect)
const initStepIndex = ref(0)
const initSteps = computed(() => [
  {
    label: 'Соединение с Битрикс24',
    done: initStepIndex.value > 0,
    active: initStepIndex.value === 0 && isLoading.value
  },
  {
    label: 'Проверка прав доступа',
    done: initStepIndex.value > 1,
    active: initStepIndex.value === 1 && isLoading.value
  },
  {
    label: 'Переход на ваш экран',
    done: initStepIndex.value > 2,
    active: initStepIndex.value === 2 && isLoading.value
  }
])
const currentCapabilities = ref({
  settings: false,
  reviewer: false,
  reports: true
})

const applyLocalPortalAdminFallback = () => {
  if (!userStore.isAdmin) {
    return
  }
  currentRole.value = 'admin'
  currentCapabilities.value = {
    settings: true,
    reviewer: true,
    reports: true
  }
}

const appScreens = [
  {
    key: 'settings',
    title: 'Настройки',
    description: 'Маппинг смарт-процессов, стадий, дедлайнов и параметров диска.',
    path: '/settings'
  },
  {
    key: 'brands',
    title: 'Бренды',
    description: 'Управление брендами: объединение АЗС, папки Bitrix Диска и внешние ссылки для партнёров.',
    path: '/brands'
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
  },
  {
    key: 'reports',
    title: 'Отчёты',
    description: 'Аналитика по отчётам: сводка, рейтинг, динамика, карточка АЗС и фото-витрина.',
    path: '/reports'
  }
] as const

const visibleScreens = computed(() => appScreens.filter((screen) => {
  if (screen.key === 'settings') {
    return Boolean(currentCapabilities.value.settings)
  }
  if (screen.key === 'brands') {
    return Boolean(currentCapabilities.value.settings)
  }
  if (screen.key === 'reviewer') {
    return Boolean(currentCapabilities.value.reviewer)
  }
  if (screen.key === 'admin') {
    return Boolean(currentCapabilities.value.reports)
  }
  if (screen.key === 'reports') {
    return Boolean(currentCapabilities.value.reviewer || currentCapabilities.value.settings || currentCapabilities.value.reports)
  }
  return false
}))

const openPage = async (path: string) => {
  await navigateTo(path)
}

const openAdminReport = async () => {
  if (openingReport.value) return
  openingReport.value = true
  homeNotice.value = ''
  try {
    const response = await apiStore.getMyActiveReport(20)
    const reportId = Number(response?.item?.id || 0)
    if (reportId > 0) {
      await navigateTo(`/admin/${reportId}`)
      return
    }
    homeNotice.value = 'Нет активного отчёта для загрузки. Дождитесь уведомления бота или создайте отчёт вручную из раздела Проверка.'
  } catch (error) {
    console.error('openAdminReport failed', error)
    toast.error('Не удалось открыть отчёт. Проверьте соединение и попробуйте ещё раз.')
  } finally {
    openingReport.value = false
  }
}

const recheckAdminReport = async () => {
  if (isLoading.value) return
  homeNotice.value = ''
  isAzsAdminWaiting.value = false
  isLoading.value = true
  initStepIndex.value = 2
  try {
    const redirected = await openMyActiveReportIfAny()
    if (!redirected) {
      isAzsAdminWaiting.value = true
    }
  } finally {
    isLoading.value = false
  }
}

let recheckTimer: ReturnType<typeof setInterval> | null = null

watch(isAzsAdminWaiting, (visible) => {
  if (visible && !recheckTimer) {
    recheckTimer = setInterval(() => {
      void recheckAdminReport().catch((err) => {
        console.warn('recheckAdminReport poll error', err)
      })
    }, 60_000)
  } else if (!visible && recheckTimer) {
    clearInterval(recheckTimer)
    recheckTimer = null
  }
}, { immediate: true })

onUnmounted(() => {
  if (recheckTimer) {
    clearInterval(recheckTimer)
    recheckTimer = null
  }
})

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

const resolveContextPath = ($frame: B24Frame): string => {
  const SAFE_PATH_RE = /^\/(admin|reason)\/\d+$/
  const candidates: unknown[] = [
    route.query.path,
    route.query['params[path]'],
  ]
  const placementOptions = parsePlacementOptions($frame)
  candidates.push(
    placementOptions.path,
    placementOptions['params[path]'],
  )
  for (const raw of candidates) {
    const s = String(raw || '').trim()
    if (SAFE_PATH_RE.test(s)) {
      return s
    }
  }
  return ''
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

const extractApiErrorMessage = (error: unknown): string => {
  if (!error || typeof error !== 'object') {
    return String(error || 'unknown_error')
  }
  const payload = error as {
    message?: string
    response?: {
      status?: number
      _data?: {
        error?: string
        message?: string
      }
    }
    data?: {
      error?: string
      message?: string
    }
  }
  const status = payload.response?.status
  const data = payload.response?._data || payload.data
  const reason = data?.message || data?.error || payload.message || 'unknown_error'
  return status ? `${status}: ${reason}` : reason
}

const checkBackend = async () => {
  try {
    if (!apiStore.isInitTokenJWT) {
      await apiStore.ensureFreshToken({ force: true })
    }

    const health = await apiStore.checkHealth()
    let roleResponse: Awaited<ReturnType<typeof apiStore.getMyRole>> | null = null
    try {
      roleResponse = await apiStore.getMyRole()
    } catch (roleError) {
      console.warn('Role endpoint failed, using /api/health role payload', roleError)
    }

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
  } catch (error) {
    applyLocalPortalAdminFallback()
    healthStatus.value = 'error'
    healthText.value = `API ошибка: ${extractApiErrorMessage(error)}`
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
    initStepIndex.value = 0

    // Step 0: connect to Bitrix24
    $b24 = await $initializeB24Frame()
    await initApp($b24, localesI18n, setLocale)
    await $b24.parent.setTitle(PAGE_TITLE)
    applyLocalPortalAdminFallback()
    initStepIndex.value = 1

    // Step 1: check roles / permissions
    const contextReportId = resolveContextReportId($b24)
    await checkBackend()
    initStepIndex.value = 2

    // Step 2: navigate to appropriate screen
    const contextPath = resolveContextPath($b24)
    if (contextPath) {
      await navigateTo(contextPath)
      return
    }

    if (contextReportId > 0) {
      await navigateTo(`/admin/${contextReportId}`)
      return
    }

    if (currentRole.value === 'azs_admin') {
      const redirectedToActive = await openMyActiveReportIfAny()
      if (redirectedToActive) {
        return
      }
      // Нет активного отчёта — показываем экран ожидания вместо меню
      initStepIndex.value = 3
      isAzsAdminWaiting.value = true
      return
    }
    initStepIndex.value = 3
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

    <!-- Loading / status panel shown while init is in progress -->
    <B24Card v-if="isLoading">
      <div class="flex flex-col items-center gap-5 py-6">
        <Logo class="size-16 text-(--ui-color-accent-soft-green-1)" />
        <div class="w-full max-w-sm space-y-2">
          <div
            v-for="(step, idx) in initSteps"
            :key="idx"
            class="flex items-center gap-2 text-sm"
          >
            <B24Badge
              :color="step.done ? 'air-primary-success' : (step.active ? 'air-primary' : 'air-secondary')"
              class="shrink-0"
            >
              {{ step.done ? '✓' : (step.active ? '...' : '○') }}
            </B24Badge>
            <span :class="step.active ? 'font-semibold' : 'text-gray-500'">{{ step.label }}</span>
          </div>
        </div>
        <ProseP small accent="less" class="text-center">Подождите, выполняется инициализация…</ProseP>
      </div>
    </B24Card>

    <!-- Main screen shown after successful init -->
    <B24Card v-if="isInit">
      <template #header>
        <div class="flex flex-row items-center justify-between gap-3">
          <div>
            <ProseH2>Фото-отчёты АЗС</ProseH2>
            <ProseP>Рабочие экраны приложения на Bitrix24 UI Kit.</ProseP>
          </div>
          <div class="flex items-center gap-2">
            <B24Badge :color="healthStatus === 'ok' ? 'air-primary-success' : (healthStatus === 'error' ? 'air-primary-alert' : 'air-secondary')">
              {{ healthText }}
            </B24Badge>
            <HelpButton default-role="admin" />
          </div>
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
            :loading="screen.key === 'admin' ? openingReport : undefined"
            :loading-auto="screen.key !== 'admin'"
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

      <!-- API error banner inside the main card -->
      <B24Alert
        v-if="healthStatus === 'error'"
        class="mt-3"
        color="air-primary-alert"
        title="Ошибка соединения с backend"
        :description="healthText"
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

    <!-- Экран ожидания для azs_admin: нет активного отчёта -->
    <B24Card v-if="isAzsAdminWaiting">
      <template #header>
        <div class="flex flex-row items-center justify-between gap-3">
          <div>
            <ProseH2>Фото-отчёты АЗС</ProseH2>
            <ProseP>Ожидание задания</ProseP>
          </div>
          <B24Badge :color="healthStatus === 'ok' ? 'air-primary-success' : (healthStatus === 'error' ? 'air-primary-alert' : 'air-secondary')">
            {{ healthText }}
          </B24Badge>
        </div>
      </template>
      <B24Alert
        color="air-secondary"
        title="Нет активного отчёта"
        description="На данный момент для вас нет активного задания на загрузку фото. Дождитесь уведомления от бота или обратитесь к проверяющему."
      />
      <template #footer>
        <div class="flex flex-row items-center justify-between w-full gap-3">
          <ProseP class="text-[12px] text-gray-500">
            Пользователь: {{ userStore.id || 'unknown' }} | Роль: {{ currentRole }}
          </ProseP>
          <div class="flex flex-col items-end gap-1">
            <div class="flex gap-2">
              <B24Button
                color="air-secondary"
                label="Обновить роль"
                loading-auto
                @click="async () => { await checkBackend(); await recheckAdminReport() }"
              />
              <B24Button
                color="air-secondary"
                label="Проверить снова"
                loading-auto
                @click="recheckAdminReport"
              />
            </div>
            <ProseP class="text-[12px] text-gray-500">Проверяем автоматически раз в минуту</ProseP>
          </div>
        </div>
      </template>
    </B24Card>

    <!-- Not initialised and not loading — something went wrong early -->
    <B24Alert
      v-if="!isInit && !isAzsAdminWaiting && !isLoading"
      color="air-primary-alert"
      title="Инициализация не завершена"
      description="Проверьте запуск через Bitrix24 iframe и доступность backend."
    />
  </div>
</template>
