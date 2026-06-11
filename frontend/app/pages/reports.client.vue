<script setup lang="ts">
import type { B24Frame } from '@bitrix24/b24jssdk'

const PAGE_TITLE = 'Отчёты АЗС'
useHead({ title: PAGE_TITLE })

const { locales: localesI18n, setLocale } = useI18n()
const { initApp, processErrorGlobal } = useAppInit('ReportsPage')
const { $initializeB24Frame } = useNuxtApp()
const apiStore = useApiStore()

type ReportTab = 'r1' | 'r2' | 'r3' | 'r4' | 'r5'
const activeTab = ref<ReportTab>('r1')

const hasAccess = ref(false)
const accessError = ref('')
const loadError = ref('')

let $b24: null | B24Frame = null

const loadPage = async () => {
  loadError.value = ''
  try {
    if (!$b24) {
      $b24 = await $initializeB24Frame()
      await initApp($b24, localesI18n, setLocale)
    }
    const roleResp = await apiStore.getMyRole()
    hasAccess.value = Boolean(
      roleResp.capabilities?.reviewer || roleResp.capabilities?.settings || roleResp.capabilities?.reports
    )
    if (!hasAccess.value) {
      accessError.value = 'Недостаточно прав для просмотра отчётов'
      return
    }
    accessError.value = ''
    await $b24.parent.setTitle(PAGE_TITLE)
  } catch (e) {
    // guard опирается на то, что после выставления accessError исключений до return не происходит;
    // при изменении логики ниже — пересмотреть (риск молчаливого поглощения ошибок)
    if (accessError.value) return // role-check already recorded
    const msg = e instanceof Error ? e.message : 'Ошибка загрузки'
    // Bitrix24Frame init errors are fatal — delegate to global error page
    if (msg.includes('Unable to initialize Bitrix24Frame')) {
      processErrorGlobal(e)
      return
    }
    loadError.value = msg
  }
}

onMounted(loadPage)
</script>

<template>
  <div class="w-full bg-[#eef1f4] min-h-screen">
    <B24Alert v-if="accessError" color="air-primary-alert" :description="accessError" class="m-4" />
    <div v-else-if="loadError" class="m-4 flex flex-col gap-2">
      <B24Alert color="air-primary-alert" title="Ошибка загрузки" :description="loadError" />
      <div>
        <button
          class="px-4 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium"
          @click="loadPage"
        >
          ↻ Повторить
        </button>
      </div>
    </div>
    <template v-else-if="hasAccess">
      <div class="flex min-h-screen">
        <ReportNav v-model:active="activeTab" class="hidden lg:block" />
        <main class="flex-1 p-6 max-w-[1180px] mx-auto w-full pb-24 lg:pb-6">
          <R1Summary v-if="activeTab === 'r1'" />
          <R2Rating  v-else-if="activeTab === 'r2'" />
          <R3Trend   v-else-if="activeTab === 'r3'" />
          <R4Card    v-else-if="activeTab === 'r4'" />
          <R5Wall    v-else-if="activeTab === 'r5'" />
        </main>
        <!-- Мобильная нижняя навигация -->
        <ReportNav v-model:active="activeTab" :mobile="true" class="lg:hidden" />
      </div>
    </template>
  </div>
</template>
